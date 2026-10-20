import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { getApiKey, setApiKey } from '../api/client';
import { Button, Field, Modal, inputClass } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧' },
  { to: '/wallets', label: 'Wallets', icon: '◫' },
  { to: '/transactions', label: 'Transactions', icon: '⇄' },
  { to: '/holds', label: 'Holds', icon: '⏸' },
  { to: '/webhooks', label: 'Webhooks', icon: '↯' },
  { to: '/reconciliation', label: 'Reconciliation', icon: '✓' },
];

function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [key, setKey] = useState(getApiKey);
  return (
    <Modal open={open} title="API settings" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setApiKey(key);
          window.location.reload();
        }}
      >
        <Field label="API key" hint="Sent as the x-api-key header. Stored in this browser only.">
          <input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Layout() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-slate-200 bg-white lg:fixed lg:inset-y-0 lg:w-60 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2 px-5 py-4">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-lg font-semibold tracking-tight text-slate-900">Ledgerly</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:pb-0">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`
              }
            >
              <span aria-hidden className="w-4 text-center">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-3 lg:absolute lg:bottom-4 lg:block lg:w-full">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
          >
            ⚙ API settings
          </button>
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-50"
          >
            ↗ API docs (Swagger)
          </a>
        </div>
      </aside>

      <main className="flex-1 px-4 py-6 sm:px-8 lg:ml-60 lg:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
