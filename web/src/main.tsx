import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const pageSize = 25;

type User = {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
  emailVerified?: boolean;
};

type UserPage = { users: User[]; hasMore: boolean };
type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: UserPage }
  | { kind: 'error'; message: string }
  | { kind: 'session-expired' };

function UsersPage() {
  const [first, setFirst] = useState(0);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setView({ kind: 'loading' });

    fetch(`/api/users?first=${first}&max=${pageSize}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401 || response.redirected || response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
          setView({ kind: 'session-expired' });
          return;
        }
        if (!response.ok) throw new Error(`Could not load users (${response.status}).`);

        const data = (await response.json()) as UserPage;
        if (!Array.isArray(data.users) || typeof data.hasMore !== 'boolean') {
          throw new Error('The server returned an unexpected user list.');
        }
        setView({ kind: 'ready', data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setView({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load users.',
        });
      });

    return () => controller.abort();
  }, [first, reload]);

  const retry = () => setReload((value) => value + 1);
  const pageNumber = Math.floor(first / pageSize) + 1;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="UDS Core User Management home">
          <strong className="brand-name">UDS Core</strong>
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-product">User Management</span>
        </a>
        <span className="topbar-label">Identity &amp; access</span>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="Primary navigation">
          <p className="nav-label">Directory</p>
          <a className="nav-link" href="#users" aria-current="page">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
              <circle cx="8" cy="6" r="3" />
              <path d="M2.5 17v-1.5A4.5 4.5 0 0 1 7 11h2a4.5 4.5 0 0 1 4.5 4.5V17M14 4.5a3 3 0 0 1 0 5.8M15 11.5a4.5 4.5 0 0 1 2.5 4V17" />
            </svg>
            Users
          </a>
        </aside>

        <main id="users" className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Directory</p>
              <h1>Users</h1>
              <p className="page-description">Accounts in the UDS Core identity realm.</p>
            </div>
            <button className="button button-secondary" onClick={retry} disabled={view.kind === 'loading'}>
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
                <path d="M16 7.5A6.5 6.5 0 1 0 16.2 12M16 3v4.5h-4.5" />
              </svg>
              Reload
            </button>
          </div>

          <section className="panel" aria-labelledby="users-heading">
            <div className="panel-heading">
              <h2 id="users-heading">User directory</h2>
            </div>

            {view.kind === 'loading' && (
              <div className="state-message" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>Loading users…</span>
              </div>
            )}

            {view.kind === 'error' && (
              <div className="state-message state-error" role="alert">
                <p>{view.message}</p>
                <button className="button button-primary" onClick={retry}>Try again</button>
                <a className="button button-secondary" href="/">Sign in again</a>
              </div>
            )}

            {view.kind === 'session-expired' && (
              <div className="state-message" role="alert">
                <div className="state-icon" aria-hidden="true">↻</div>
                <h3>Your session may have expired</h3>
                <p>Reload the application to sign in again.</p>
                <a className="button button-primary" href="/">Reload application</a>
              </div>
            )}

            {view.kind === 'ready' && view.data.users.length === 0 && (
              <div className="state-message">
                <div className="state-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20v-1.8a5.2 5.2 0 0 1 5.2-5.2h2.6a5.2 5.2 0 0 1 5.2 5.2V20M17 8.5a3.5 3.5 0 0 1 0 6.8M18 14.5a5.1 5.1 0 0 1 3.5 4.9V20" /></svg>
                </div>
                <h3>No users found</h3>
                <p>There are no users to display on this page.</p>
              </div>
            )}

            {view.kind === 'ready' && view.data.users.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Username</th>
                      <th scope="col">Name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.data.users.map((user) => {
                      const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
                      const status = user.enabled === true ? 'Enabled' : user.enabled === false ? 'Disabled' : 'Unknown';
                      const statusClass = user.enabled === true ? 'status-enabled' : user.enabled === false ? 'status-disabled' : 'status-unknown';
                      return (
                        <tr key={user.id}>
                          <td className="username-cell">{user.username || '—'}</td>
                          <td>{name || '—'}</td>
                          <td>{user.email || '—'}</td>
                          <td>
                            <span className={`status-pill ${statusClass}`}>
                              <span aria-hidden="true" className="status-dot" />
                              {status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {view.kind === 'ready' && (view.data.users.length > 0 || first > 0 || view.data.hasMore) && (
              <nav className="pagination" aria-label="User pages">
                <span className="pagination-label">Page {pageNumber}</span>
                <div className="pagination-controls">
                  <button className="button button-secondary" onClick={() => setFirst((value) => Math.max(0, value - pageSize))} disabled={first === 0}>
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m12.5 4.5-5.5 5.5 5.5 5.5" /></svg>
                    Previous
                  </button>
                  <button className="button button-secondary" onClick={() => setFirst((value) => value + pageSize)} disabled={!view.data.hasMore}>
                    Next
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m7.5 4.5 5.5 5.5-5.5 5.5" /></svg>
                  </button>
                </div>
              </nav>
            )}
          </section>
          <footer className="page-footer">UDS Core · Identity &amp; access</footer>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UsersPage />
  </StrictMode>,
);
