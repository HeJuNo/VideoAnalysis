import { useEffect, useState } from 'react';
import type { UserDto } from '../../shared/types.ts';
import { api, onUnauthorized } from './api.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { PlayerPage } from './pages/PlayerPage.tsx';
import { SessionPage } from './pages/SessionPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { ProfileEditorPage } from './profiles/ProfileEditorPage.tsx';
import { ProfilesPage } from './profiles/ProfilesPage.tsx';
import { AthletesPage } from './pages/AthletesPage.tsx';
import { StatusPage } from './pages/StatusPage.tsx';
import { ReviewQueuePage } from './review/ReviewQueuePage.tsx';
import { ReviewScenePage } from './review/ReviewScenePage.tsx';
import { TaggerPage } from './tagging/TaggerPage.tsx';
import { href, useRoute } from './router.ts';

export function App() {
  // undefined while checking the session cookie, null when signed out.
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  const route = useRoute();

  useEffect(() => {
    api<{ user: UserDto }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => setUser(null));
    return onUnauthorized(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (!user) return <LoginPage onLogin={setUser} />;

  const section =
    route.name === 'profiles' || route.name === 'profile'
      ? 'profiles'
      : route.name === 'review' || route.name === 'scene'
        ? 'review'
        : route.name === 'athletes'
          ? 'athletes'
          : route.name === 'status'
            ? 'status'
            : 'sessions';

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.sessions()}>
          Video Analysis
        </a>
        <nav className="nav">
          <a href={href.sessions()} className={section === 'sessions' ? 'active' : undefined}>
            Sessions
          </a>
          {user.role === 'analyst' && (
            <a href={href.review()} className={section === 'review' ? 'active' : undefined}>
              Review
            </a>
          )}
          <a href={href.athletes()} className={section === 'athletes' ? 'active' : undefined}>
            Athletes
          </a>
          <a href={href.profiles()} className={section === 'profiles' ? 'active' : undefined}>
            Profiles
          </a>
          <a href={href.status()} className={section === 'status' ? 'active' : undefined}>
            Status
          </a>
        </nav>
        <span className="spacer" />
        <span className="muted">
          {user.email} · {user.role}
        </span>
        <button className="link" onClick={logout}>
          Sign out
        </button>
      </header>
      <main>
        {route.name === 'sessions' && <SessionsPage />}
        {route.name === 'session' && <SessionPage key={route.id} id={route.id} user={user} />}
        {route.name === 'video' && <PlayerPage key={route.id} id={route.id} />}
        {route.name === 'tag' && <TaggerPage key={route.id} id={route.id} user={user} />}
        {route.name === 'review' && <ReviewQueuePage key={route.sessionId ?? 'all'} sessionId={route.sessionId} />}
        {route.name === 'scene' && <ReviewScenePage key={route.id} id={route.id} user={user} />}
        {route.name === 'athletes' && <AthletesPage />}
        {route.name === 'status' && <StatusPage />}
        {route.name === 'profiles' && <ProfilesPage user={user} />}
        {route.name === 'profile' && <ProfileEditorPage key={route.id} id={route.id} user={user} />}
      </main>
    </div>
  );
}
