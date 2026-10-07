import * as Speech from 'expo-speech';
import * as FileSystem from 'expo-file-system/legacy';

import { canUseDirectOpenAIClient } from '../../config/ai-routing';
import { hasOpenAIApiKey, getOpenAIApiKey } from '../../config/env';
import { isTtsGatewayConfiguredFromEnv } from '../../config/tts-gateway-env';
import { VoicePersonality } from '../../types/user-profile';
import { VoiceSpeechConfig } from '../../types/voice-identity';
import { VOICE_PERSONALITY_PROFILES } from '../../types/voice-call';
import { audioSessionManager, createAudioPlayer } from '../audio/audio-session-manager';
import { setVoiceDebugState, ttsLog } from './voice-debug-state';
import { clipTextForTtsGateway, resolveAllowedTtsVoice } from './tts-contract';
import { invokeTtsGatewayOrThrow } from './tts-gateway-client';
import { hasAudioPlaybackCompleted, hasAudioPlaybackStarted } from './audio-playback-complete';

export interface ITextToSpeechService {
  speak(text: string, config: VoiceSpeechConfig | VoicePersonality): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): void;
  isSpeaking(): boolean;
}

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const PLAYBACK_TIMEOUT_MS = 45_000;
/** iOS can delay expo-speech onStart after expo-audio session changes. */
const PLAYBACK_START_TIMEOUT_MS = 8_000;
const SESSION_SETTLE_MS = 120;

const LEGACY_SPEECH: Record<VoicePersonality, { pitch: number; rate: number; voice?: string }> = {
  warm_calm: { pitch: 0.95, rate: 0.9, voice: 'nova' },
  gentle: { pitch: 1.0, rate: 0.85, voice: 'shimmer' },
  energetic: { pitch: 1.08, rate: 1.08, voice: 'coral' },
  direct: { pitch: 1.0, rate: 1.05, voice: 'onyx' },
};

function resolveConfig(config: VoiceSpeechConfig | VoicePersonality): VoiceSpeechConfig {
  if (typeof config === 'string') {
    const profile = VOICE_PERSONALITY_PROFILES.find((item) => item.id === config);
    const legacy = LEGACY_SPEECH[config];
    return {
      openAiVoiceId: profile?.ttsVoiceId ?? legacy.voice ?? 'nova',
      expoPitch: profile?.expoPitch ?? legacy.pitch,
      expoRate: profile?.expoRate ?? legacy.rate,
      speedMultiplier: profile?.expoRate ?? legacy.rate,
    };
  }
  return config;
}

/**
 * Prefer curated OpenAI-mapped voices.
 * - Development may use client OpenAI when a key is present (never in release).
 * - Preview/production use the authenticated tts-gateway (server OPENAI_API_KEY).
 * - expo-speech is only used when no cloud TTS path exists (offline / misconfigured),
 *   never as a silent substitute that pretends to be the selected Voxa voice.
 */
function preferCloudTts(): 'client_openai' | 'gateway' | 'on_device_only' {
  if (hasOpenAIApiKey() && canUseDirectOpenAIClient()) return 'client_openai';
  if (isTtsGatewayConfiguredFromEnv()) return 'gateway';
  return 'on_device_only';
}

export class HybridTextToSpeechService implements ITextToSpeechService {
  private muted = false;
  private speaking = false;
  private cancelled = false;

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) void this.stop();
  }

  isSpeaking() {
    return this.speaking;
  }

  async speak(text: string, config: VoiceSpeechConfig | VoicePersonality): Promise<void> {
    const trimmed = text.trim();
    if (this.muted || !trimmed) return;

    this.cancelled = false;
    await this.stopPlaybackOnly();
    this.speaking = true;
    ttsLog('TTS START', trimmed.slice(0, 48));

    const speechConfig = resolveConfig(config);
    const path = preferCloudTts();

    try {
      await audioSessionManager.prepareForPlayback('tts');

      if (path === 'client_openai') {
        try {
          await this.speakOpenAI(trimmed, speechConfig);
          return;
        } catch (err) {
          if (this.cancelled) return;
          if (isTtsGatewayConfiguredFromEnv()) {
            ttsLog('TTS STUCK FALLBACK', 'client openai → gateway');
            await audioSessionManager.unloadPlaybackSound();
            await this.speakGateway(trimmed, speechConfig);
            return;
          }
          const message = err instanceof Error ? err.message : 'OpenAI TTS failed';
          ttsLog('TTS STUCK FALLBACK', message);
          throw err instanceof Error ? err : new Error(message);
        }
      }

      if (path === 'gateway') {
        await this.speakGateway(trimmed, speechConfig);
        return;
      }

      await this.speakExpo(trimmed, speechConfig);
    } catch (err) {
      if (this.cancelled) return;
      const message = err instanceof Error ? err.message : 'TTS failed';
      ttsLog('TTS ERROR', message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.speaking = false;
      await audioSessionManager.releaseLock('tts');
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    await this.stopPlaybackOnly();
    await audioSessionManager.releaseLock('tts');
    this.speaking = false;
  }

  private async stopPlaybackOnly() {
    Speech.stop();
    await audioSessionManager.unloadPlaybackSound();
  }

  private async speakExpo(text: string, config: VoiceSpeechConfig) {
    if (this.cancelled) return;
    ttsLog('TTS FALLBACK EXPO');
    ttsLog('TTS PROVIDER', 'expo-speech');
    setVoiceDebugState({ ttsProvider: 'expo-speech' });
    await audioSessionManager.setPlaybackMode();
    await new Promise((resolve) => setTimeout(resolve, SESSION_SETTLE_MS));
    if (this.cancelled) return;
    ttsLog('TTS AUDIO READY');

    let playbackStarted = false;
    let settled = false;

    await new Promise<void>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        clearInterval(speakingPoll);
        fn();
      };

      const startTimer = setTimeout(() => {
        if (!playbackStarted) {
          Speech.stop();
          finish(() => reject(new Error('expo-speech playback did not start within 8s')));
        }
      }, PLAYBACK_START_TIMEOUT_MS);

      const speakingPoll = setInterval(() => {
        void Speech.isSpeakingAsync().then((speaking) => {
          if (speaking && !playbackStarted) {
            playbackStarted = true;
            clearTimeout(startTimer);
            ttsLog('TTS PLAYBACK START', 'expo-speech (polled)');
          }
        });
      }, 250);

      Speech.speak(text, {
        pitch: config.expoPitch,
        rate: config.expoRate,
        onStart: () => {
          playbackStarted = true;
          clearTimeout(startTimer);
          ttsLog('TTS PLAYBACK START', 'expo-speech');
        },
        onDone: () => {
          ttsLog('TTS PLAYBACK END', 'expo-speech');
          finish(resolve);
        },
        onStopped: () => {
          ttsLog('TTS PLAYBACK END', 'expo-speech stopped');
          finish(resolve);
        },
        onError: () => {
          finish(() => reject(new Error('expo-speech playback failed')));
        },
      });
    });
  }

  private async speakGateway(text: string, config: VoiceSpeechConfig) {
    if (this.cancelled) return;
    const voice = resolveAllowedTtsVoice(config.openAiVoiceId);
    if (!voice) {
      throw new Error('Selected voice is not available for speech.');
    }

    ttsLog('TTS PROVIDER', 'tts-gateway');
    setVoiceDebugState({ ttsProvider: 'tts-gateway' });

    const { audioBytes } = await invokeTtsGatewayOrThrow({
      text: clipTextForTtsGateway(text),
      voice,
      speed: Math.min(4, Math.max(0.25, config.speedMultiplier)),
    });

    if (this.cancelled) return;
    if (!audioBytes.byteLength) {
      throw new Error('TTS gateway returned empty audio');
    }

    await this.playMpegBytes(audioBytes, 'tts-gateway');
  }

  private async speakOpenAI(text: string, config: VoiceSpeechConfig) {
    if (this.cancelled) return;
    const apiKey = getOpenAIApiKey();
    if (!apiKey) throw new Error('OpenAI API key missing');

    ttsLog('TTS PROVIDER', 'openai');
    setVoiceDebugState({ ttsProvider: 'OpenAI TTS' });

    const response = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: config.openAiVoiceId,
        input: text.slice(0, 4096),
        response_format: 'mp3',
        speed: Math.min(4, Math.max(0.25, config.speedMultiplier)),
      }),
    });

    if (this.cancelled) return;
    if (!response.ok) throw new Error(`OpenAI TTS HTTP ${response.status}`);

    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error('OpenAI TTS returned empty audio');
    if (this.cancelled) return;

    await this.playMpegBytes(bytes, 'openai');
  }

  private async playMpegBytes(bytes: ArrayBuffer, providerLabel: string) {
    ttsLog('TTS AUDIO READY', `${bytes.byteLength} bytes`);

    const base64 = arrayBufferToBase64(bytes);
    const uri = `${FileSystem.cacheDirectory}voxa-tts-${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });

    await audioSessionManager.setPlaybackMode();
    await audioSessionManager.unloadPlaybackSound();

    const player = createAudioPlayer({ uri }, { updateInterval: 200 });
    audioSessionManager.registerPlaybackSound(player);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let playbackStarted = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(startTimeout);
        clearTimeout(playTimeout);
        try {
          statusSub?.remove();
        } catch {
          // ignore
        }
        fn();
      };

      const onStatus = (status: {
        isLoaded?: boolean;
        playing?: boolean;
        didJustFinish?: boolean;
        currentTime?: number;
        duration?: number;
        playbackState?: string;
      }) => {
        if (this.cancelled) {
          finish(resolve);
          return;
        }
        if (hasAudioPlaybackStarted(status)) {
          playbackStarted = true;
          clearTimeout(startTimeout);
        }
        if (hasAudioPlaybackCompleted(status, playbackStarted)) {
          ttsLog('TTS PLAYBACK END', providerLabel);
          finish(resolve);
        }
      };

      const statusSub = player.addListener('playbackStatusUpdate', onStatus);

      const startTimeout = setTimeout(() => {
        if (!playbackStarted) {
          ttsLog('TTS STUCK FALLBACK', `${providerLabel} playback did not start within 8s`);
          finish(() => reject(new Error('TTS playback did not start within 8s')));
        }
      }, PLAYBACK_START_TIMEOUT_MS);

      const playTimeout = setTimeout(() => {
        finish(() => reject(new Error('TTS playback timed out')));
      }, PLAYBACK_TIMEOUT_MS);

      const poll = setInterval(() => {
        if (this.cancelled) {
          finish(resolve);
          return;
        }
        onStatus(player.currentStatus);
      }, 100);

      try {
        player.play();
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error('TTS play failed')));
      }
    });

    await audioSessionManager.unloadPlaybackSound();
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let sharedTts: HybridTextToSpeechService | null = null;

export function getSharedTextToSpeechService(): ITextToSpeechService {
  if (!sharedTts) sharedTts = new HybridTextToSpeechService();
  return sharedTts;
}

export function createTextToSpeechService(): ITextToSpeechService {
  return getSharedTextToSpeechService();
}

export async function forceStopAllTts() {
  if (sharedTts) await sharedTts.stop();
}
