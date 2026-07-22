/**
 * AuthContext.tsx — the SPA's view of the session.
 *
 * The access token lives in an httpOnly cookie the SPA cannot read (by design),
 * so the SPA learns "who am I?" by calling the BFF's GET /auth/me once on mount.
 * This context caches that result and exposes login()/signup()/logout().
 *
 * Wrap your app:
 *   <AuthProvider><RouterProvider router={router} /></AuthProvider>
 *
 * Read it anywhere:
 *   const { user, status, login, logout } = useAuth();
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchCurrentUser,
  startLogin,
  startSignup,
  logout as logoutApi,
  type CurrentUser,
} from './auth-api';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: CurrentUser | null;
  status: AuthStatus;
  login: () => void;
  signup: () => void;
  logout: () => void;
  /** Re-check the session against the BFF (e.g. after returning from the callback). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  async function load() {
    const u = await fetchCurrentUser();
    setUser(u);
    setStatus(u ? 'authenticated' : 'anonymous');
  }

  useEffect(() => {
    void load();
  }, []);

  const value: AuthContextValue = {
    user,
    status,
    login: startLogin,
    signup: startSignup,
    logout: logoutApi, // top-level navigation to the BFF → IDP end_session; state reset is moot
    refresh: load,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
