export type PlaybackStatusLike = {
  isLoaded?: boolean;
  playing?: boolean;
  didJustFinish?: boolean;
  currentTime?: number;
  duration?: number;
  playbackState?: string;
};

export function hasAudioPlaybackStarted(status: PlaybackStatusLike): boolean {
  if (status.playing) return true;
  return (status.currentTime ?? 0) > 0.05;
}

/**
 * expo-audio `didJustFinish` is a one-frame flag. Polling can miss it and leave
 * Talk stuck on "Speaking...". Treat ended/near-end as complete too.
 */
export function hasAudioPlaybackCompleted(status: PlaybackStatusLike, playbackStarted: boolean): boolean {
  if (!playbackStarted) return false;
  if (status.didJustFinish) return true;
  if (status.isLoaded === false) return false;
  const state = (status.playbackState ?? '').toLowerCase();
  if (state.includes('ended') || state === 'complete' || state.includes('stopped')) return true;
  if (status.playing) return false;
  const duration = status.duration ?? 0;
  const time = status.currentTime ?? 0;
  if (duration > 0.25 && time >= duration - 0.2) return true;
  return false;
}
