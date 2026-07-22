/**
 * ProtectedRoute.tsx — gate routes behind an Overlens session (React Router v6+).
 *
 * Usage with createBrowserRouter:
 *   {
 *     element: <ProtectedRoute />,        // layout route guarding its children
 *     children: [
 *       { path: '/dashboard', element: <Dashboard /> },
 *       { path: '/settings', element: <Settings /> },
 *     ],
 *   }
 *
 * While the session check is in flight we render nothing (or a spinner) rather
 * than flashing the login screen. When anonymous we send the user to the BFF
 * login route via startLogin() — NOT a client-side <Navigate>, because login is
 * a real navigation off the SPA to Accounts.
 */
import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { startLogin } from './auth-api';

export function ProtectedRoute() {
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'anonymous') {
      startLogin(); // leaves the SPA → BFF /auth/login → Accounts
    }
  }, [status]);

  if (status === 'loading') {
    return null; // or a spinner / skeleton
  }

  if (status === 'anonymous') {
    return null; // redirect is happening in the effect above
  }

  return <Outlet />;
}
