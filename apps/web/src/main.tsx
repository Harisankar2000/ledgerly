import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ApiError } from './api/client';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { HoldsPage } from './pages/HoldsPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { WalletDetailPage } from './pages/WalletDetailPage';
import { WalletsPage } from './pages/WalletsPage';
import { WebhooksPage } from './pages/WebhooksPage';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Do not retry client errors (404, 401, 422): they will not fix themselves.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="wallets" element={<WalletsPage />} />
            <Route path="wallets/:accountId" element={<WalletDetailPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="holds" element={<HoldsPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="reconciliation" element={<ReconciliationPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
