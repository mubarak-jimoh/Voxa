import { invalidateDashboardCache } from '../../hooks/use-cached-dashboard';
import { stopAllSpeech } from '../voice/speech-playback-coordinator';

export function resetTransientSessionState(): void {
  invalidateDashboardCache();
  void stopAllSpeech();
}
