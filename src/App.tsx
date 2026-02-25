import { useEffect } from 'react';
import {
  createHashRouter,
  createRoutesFromElements,
  Outlet,
  Route,
  RouterProvider,
} from 'react-router-dom';
import { LoginPage } from '@/pages/LoginPage';
import { DetailedRequestsPage } from '@/pages/DetailedRequestsPage';
import { NotificationContainer } from '@/components/common/NotificationContainer';
import { ConfirmationModal } from '@/components/common/ConfirmationModal';
import { MainLayout } from '@/components/layout/MainLayout';
import { ProtectedRoute } from '@/router/ProtectedRoute';
import { useLanguageStore, useThemeStore } from '@/stores';

function AppShell() {
  return (
    <>
      <NotificationContainer />
      <ConfirmationModal />
      <Outlet />
    </>
  );
}

const router = createHashRouter(
  createRoutesFromElements(
    <Route element={<AppShell />}>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/detailed-requests"
        element={
          <ProtectedRoute>
            <DetailedRequestsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }
      />
    </Route>
  )
);

function App() {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  useEffect(() => {
    const cleanupTheme = initializeTheme();
    return cleanupTheme;
  }, [initializeTheme]);

  useEffect(() => {
    setLanguage(language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <RouterProvider router={router} />;
}

export default App;
