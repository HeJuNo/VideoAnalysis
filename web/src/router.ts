import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'sessions' }
  | { name: 'session'; id: string }
  | { name: 'video'; id: string }
  | { name: 'tag'; id: string }
  | { name: 'profiles' }
  | { name: 'profile'; id: string }
  | { name: 'review'; sessionId: string | null }
  | { name: 'scene'; id: string }
  | { name: 'athletes' }
  | { name: 'status' };

export const href = {
  sessions: () => '#/',
  session: (id: string) => `#/sessions/${id}`,
  video: (id: string) => `#/videos/${id}`,
  tag: (id: string) => `#/videos/${id}/tag`,
  profiles: () => '#/profiles',
  profile: (id: string) => `#/profiles/${id}`,
  review: (sessionId?: string | null) => (sessionId ? `#/review/${sessionId}` : '#/review'),
  scene: (id: string) => `#/scenes/${id}`,
  athletes: () => '#/athletes',
  status: () => '#/status',
};

export function navigate(to: string): void {
  window.location.hash = to;
}

export function parseRoute(hash: string): Route {
  const [, section, id, sub] = hash.replace(/^#/, '').split('/');
  if (section === 'sessions' && id) return { name: 'session', id };
  if (section === 'videos' && id) return sub === 'tag' ? { name: 'tag', id } : { name: 'video', id };
  if (section === 'profiles') return id ? { name: 'profile', id } : { name: 'profiles' };
  if (section === 'review') return { name: 'review', sessionId: id || null };
  if (section === 'scenes' && id) return { name: 'scene', id };
  if (section === 'athletes') return { name: 'athletes' };
  if (section === 'status') return { name: 'status' };
  return { name: 'sessions' };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
