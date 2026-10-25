/**
 * "AI connections": the agents the bridge can talk to (ai-bridge/
 * connections.mjs), which one answers the chat and which writes parts cards,
 * and the model of each.
 *
 * A Claude Code account is a config folder: an existing signed-in one (e.g.
 * ~/.claude-work), or a new one signed in here — the bridge runs `claude auth
 * login`, this dialog opens its link and passes on the code the sign-in page
 * shows. An API connection (Anthropic, OpenAI, OpenRouter, an OpenAI-
 * compatible server, Ollama) is a key and a model: the key goes to the
 * bridge, which keeps it in the system keychain and never sends it back; the
 * models come from the provider. Nothing here ever sees a password.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ExternalLink, Loader2, Trash2, X } from 'lucide-react';
import { useAiStore, type AiConnection, type AiConnectionKind } from '../../store/useAiStore';
import './AiConnectionsDialog.css';

/** Beyond this many models a filter box helps (OpenRouter lists hundreds). */
const FILTER_FROM = 30;

const AccountLine: React.FC<{ c: AiConnection; kind?: AiConnectionKind }> = ({ c, kind }) => {
  const { t } = useTranslation();
  if (kind?.api) {
    if (kind.key === 'none') return <span className="aic-account aic-ok">{c.baseUrl ?? kind.baseUrl}</span>;
    return c.account.keySet ? (
      <span className="aic-account aic-ok">
        <Check size={12} /> {t('aiConnections.keySaved', 'key saved in the keychain')}
        {c.baseUrl ? ` · ${c.baseUrl}` : ''}
      </span>
    ) : (
      <span className="aic-account aic-bad">{t('aiConnections.noKey', 'no API key')}</span>
    );
  }
  if (c.account.loggedIn) {
    return (
      <span className="aic-account aic-ok">
        <Check size={12} /> {c.account.email ?? t('aiConnections.signedIn', 'signed in')}
        {c.account.subscription ? ` · ${c.account.subscription}` : ''}
      </span>
    );
  }
  return <span className="aic-account aic-bad">{c.account.error ?? t('aiConnections.notSignedIn', 'not signed in')}</span>;
};

/** A model picker over a provider's list (with a filter for long ones). */
const ModelSelect: React.FC<{
  value: string;
  models: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
  disabled?: boolean;
}> = ({ value, models, onChange, disabled }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)) : models;
    // The current model stays choosable even when the filter or the list misses it.
    return value && !list.some((m) => m.id === value) ? [{ id: value, label: value }, ...list] : list;
  }, [models, filter, value]);
  return (
    <>
      {models.length > FILTER_FROM && (
        <input
          className="aic-input aic-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('aiConnections.filterModels', 'filter models')}
        />
      )}
      <select className="aic-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} title={t('aiConnections.model', 'Model')}>
        {!value && <option value="">{t('aiConnections.pickModel', '— pick a model —')}</option>}
        {shown.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label.toLowerCase() === m.id.toLowerCase() || !m.id.includes('-') ? m.label : `${m.label} (${m.id})`}
          </option>
        ))}
      </select>
    </>
  );
};

const LoginBox: React.FC<{ id: string }> = ({ id }) => {
  const { t } = useTranslation();
  const login = useAiStore((s) => s.login);
  const { connectionCommand, clearLogin } = useAiStore.getState();
  const [code, setCode] = useState('');
  if (!login || login.id !== id) return null;
  if (login.done) {
    return (
      <div className={`aic-login ${login.ok ? 'aic-ok' : 'aic-bad'}`}>
        {login.ok
          ? t('aiConnections.loginOk', { email: login.email ?? '', defaultValue: 'Signed in {{email}}' })
          : t('aiConnections.loginFailed', { error: login.error ?? '', defaultValue: 'Sign-in failed: {{error}}' })}
        <button className="aic-link" onClick={clearLogin}>
          {t('aiConnections.ok', 'OK')}
        </button>
      </div>
    );
  }
  return (
    <div className="aic-login">
      {!login.url ? (
        <span>
          <Loader2 size={12} className="ai-spin" /> {t('aiConnections.loginStarting', 'Starting the sign-in…')}
        </span>
      ) : (
        <>
          <ol>
            <li>
              <a href={login.url} target="_blank" rel="noreferrer">
                {t('aiConnections.openLogin', 'Open the Claude sign-in page')} <ExternalLink size={11} />
              </a>{' '}
              {t('aiConnections.loginHint', 'and sign in with the account you want here.')}
            </li>
            <li>{t('aiConnections.pasteCode', 'Copy the code the page shows and paste it here:')}</li>
          </ol>
          <div className="aic-row">
            <input
              className="aic-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('aiConnections.codePlaceholder', 'code from the sign-in page')}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="aic-primary"
              disabled={!code.trim()}
              onClick={() => {
                connectionCommand({ type: 'connection_login_code', id, code: code.trim() });
                setCode('');
              }}
            >
              {t('aiConnections.submitCode', 'Sign in')}
            </button>
          </div>
        </>
      )}
      <button className="aic-link" onClick={() => connectionCommand({ type: 'connection_login_cancel', id })}>
        {t('aiConnections.cancel', 'Cancel')}
      </button>
    </div>
  );
};

/** Replace the key of an API connection. */
const KeyBox: React.FC<{ id: string; onDone: () => void }> = ({ id, onDone }) => {
  const { t } = useTranslation();
  const { connectionCommand } = useAiStore.getState();
  const [key, setKey] = useState('');
  return (
    <div className="aic-row">
      <input
        className="aic-input"
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={t('aiConnections.keyPlaceholder', 'API key')}
        autoComplete="off"
      />
      <button
        className="aic-primary"
        disabled={!key.trim()}
        onClick={() => {
          connectionCommand({ type: 'connection_set_key', id, apiKey: key.trim() });
          onDone();
        }}
      >
        {t('aiConnections.saveKey', 'Save key')}
      </button>
      <button className="aic-link" onClick={onDone}>
        {t('aiConnections.cancel', 'Cancel')}
      </button>
    </div>
  );
};

const AddForm: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t } = useTranslation();
  const connections = useAiStore((s) => s.connections);
  const list = useAiStore((s) => s.modelLists.new);
  const { connectionCommand, loadModels } = useAiStore.getState();
  const kinds = connections?.kinds ?? {};
  const [kind, setKind] = useState('claude-code');
  const meta = kinds[kind];
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'new' | 'folder'>('new');
  const [folder, setFolder] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('sonnet');

  const pickKind = (k: string) => {
    setKind(k);
    setBaseUrl(kinds[k]?.needsBaseUrl ? '' : k === 'ollama' ? (kinds[k]?.baseUrl ?? '') : '');
    setApiKey('');
    setModel(k === 'claude-code' ? 'sonnet' : '');
    useAiStore.setState((s) => ({ modelLists: { ...s.modelLists, new: {} } }));
  };
  const keyMissing = meta?.key === 'required' && !apiKey.trim();
  const urlMissing = !!meta?.needsBaseUrl && !baseUrl.trim();
  const fetchModels = () =>
    loadModels('new', { kind, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });

  return (
    <div className="aic-add">
      <div className="aic-row">
        <span className="aic-add-title">{t('aiConnections.addTitle', 'New connection')}</span>
        <select className="aic-select" value={kind} onChange={(e) => pickKind(e.target.value)}>
          {Object.entries(kinds).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <input
        className="aic-input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('aiConnections.labelPlaceholder', 'Name, e.g. Work')}
      />
      {!meta?.api ? (
        <>
          <div className="aic-row">
            <select className="aic-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {(meta?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <label className="aic-radio">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
            {t('aiConnections.modeNew', 'Sign in to an account (opens the Claude sign-in page)')}
          </label>
          <label className="aic-radio">
            <input type="radio" checked={mode === 'folder'} onChange={() => setMode('folder')} />
            {t('aiConnections.modeFolder', 'A folder already signed in on this computer')}
          </label>
          {mode === 'folder' && (
            <input className="aic-input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/.claude-work" spellCheck={false} />
          )}
        </>
      ) : (
        <>
          {(meta.needsBaseUrl || kind === 'ollama') && (
            <input
              className="aic-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta.baseUrl ?? 'https://my-gateway.example.com/v1'}
              spellCheck={false}
            />
          )}
          {meta.key !== 'none' && (
            <input
              className="aic-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                meta.key === 'optional'
                  ? t('aiConnections.keyOptional', 'API key (if the server asks for one)')
                  : t('aiConnections.keyPlaceholder', 'API key')
              }
              autoComplete="off"
            />
          )}
          <div className="aic-row">
            <button className="aic-link" disabled={keyMissing || urlMissing || list?.loading} onClick={fetchModels}>
              {list?.loading ? <Loader2 size={12} className="ai-spin" /> : null} {t('aiConnections.loadModels', 'Check and load the models')}
            </button>
            {list?.error && <span className="aic-error">{list.error}</span>}
          </div>
          {list?.models && <ModelSelect value={model} models={list.models} onChange={setModel} />}
          {meta.key !== 'none' && (
            <p className="aic-intro">{t('aiConnections.keyNote', 'The key is kept in the keychain of this computer by the AI bridge; the IDE does not store it.')}</p>
          )}
        </>
      )}
      <div className="aic-row aic-end">
        <button className="aic-link" onClick={onDone}>
          {t('aiConnections.cancel', 'Cancel')}
        </button>
        <button
          className="aic-primary"
          disabled={meta?.api ? keyMissing || urlMissing || !model : mode === 'folder' && !folder.trim()}
          onClick={() => {
            connectionCommand(
              meta?.api
                ? {
                    type: 'connection_add',
                    kind,
                    label: label.trim(),
                    model,
                    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                  }
                : {
                    type: 'connection_add',
                    kind,
                    label: label.trim(),
                    model,
                    ...(mode === 'folder' ? { configDir: folder.trim() } : {}),
                    signIn: mode === 'new',
                  },
            );
            onDone();
          }}
        >
          {t('aiConnections.add', 'Add')}
        </button>
      </div>
    </div>
  );
};

const ConnectionRow: React.FC<{ c: AiConnection }> = ({ c }) => {
  const { t } = useTranslation();
  const connections = useAiStore((s) => s.connections)!;
  const login = useAiStore((s) => s.login);
  const list = useAiStore((s) => s.modelLists[c.id]);
  const { connectionCommand, loadModels } = useAiStore.getState();
  const [keyOpen, setKeyOpen] = useState(false);
  const kind = connections.kinds[c.kind];
  const api = !!kind?.api;
  useEffect(() => {
    if (api && c.account.loggedIn && !list) loadModels(c.id, { id: c.id });
  }, [api, c.id, c.account.loggedIn, list, loadModels]);
  const models = api ? (list?.models ?? []) : (kind?.models ?? []);

  return (
    <div className="aic-item">
      <div className="aic-row">
        <span className="aic-label">{c.label}</span>
        <span className="aic-kind">
          {kind?.label ?? c.kind}
          {c.system ? ` · ${t('aiConnections.system', 'the bridge’s own login')}` : ''}
          {c.configDir ? ` · ${c.configDir}` : ''}
        </span>
      </div>
      <div className="aic-row">
        <AccountLine c={c} kind={kind} />
        <ModelSelect value={c.model} models={models} onChange={(model) => connectionCommand({ type: 'connection_update', id: c.id, model })} />
      </div>
      {list?.error && <div className="aic-error">{list.error}</div>}
      <div className="aic-row">
        <label className="aic-radio">
          <input
            type="radio"
            name="aic-chat"
            checked={connections.selected.chat === c.id}
            onChange={() => connectionCommand({ type: 'connection_select', role: 'chat', id: c.id })}
          />
          {t('aiConnections.forChat', 'answers the chat')}
        </label>
        <label className="aic-radio">
          <input
            type="radio"
            name="aic-cards"
            checked={connections.selected.cards === c.id}
            onChange={() => connectionCommand({ type: 'connection_select', role: 'cards', id: c.id })}
          />
          {t('aiConnections.forCards', 'writes sensor cards')}
        </label>
        <span className="aic-spacer" />
        {!api && !c.account.loggedIn && !c.system && !c.configDir && !c.signingIn && login?.id !== c.id && (
          <button className="aic-link" onClick={() => connectionCommand({ type: 'connection_login', id: c.id })}>
            {t('aiConnections.signIn', 'Sign in')}
          </button>
        )}
        {api && kind?.key !== 'none' && !keyOpen && (
          <button className="aic-link" onClick={() => setKeyOpen(true)}>
            {c.account.keySet ? t('aiConnections.replaceKey', 'Replace key') : t('aiConnections.setKey', 'Set key')}
          </button>
        )}
        {!c.system && (
          <button
            className="ai-icon-btn"
            onClick={() => connectionCommand({ type: 'connection_remove', id: c.id })}
            title={t('aiConnections.remove', 'Remove')}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {keyOpen && (
        <KeyBox
          id={c.id}
          onDone={() => {
            setKeyOpen(false);
            useAiStore.setState((s) => {
              const rest = { ...s.modelLists };
              delete rest[c.id];
              return { modelLists: rest };
            });
          }}
        />
      )}
      <LoginBox id={c.id} />
    </div>
  );
};

export const AiConnectionsDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const connections = useAiStore((s) => s.connections);
  const error = useAiStore((s) => s.connectionError);
  const [adding, setAdding] = useState(false);

  return createPortal(
    <div className="ai-big-overlay" onClick={onClose}>
      <div
        className="ai-big-dialog aic-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('aiConnections.title', 'AI connections')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="ai-big-head">
          <Bot size={16} />
          <span>{t('aiConnections.title', 'AI connections')}</span>
          <button className="ai-icon-btn" onClick={onClose} title={t('aiPanel.close', 'Close')}>
            <X size={14} />
          </button>
        </div>
        <p className="aic-intro">
          {t(
            'aiConnections.intro',
            'Who answers the chat and who writes sensor cards. Accounts are signed in on this computer; the IDE never sees a password.',
          )}
        </p>
        {error && <div className="aic-error">{error}</div>}
        {!connections ? (
          <div className="aic-intro">
            <Loader2 size={12} className="ai-spin" /> {t('aiConnections.loading', 'Asking the bridge…')}
          </div>
        ) : (
          <div className="aic-list">
            {connections.connections.map((c) => (
              <ConnectionRow key={c.id} c={c} />
            ))}
          </div>
        )}
        {adding ? (
          <AddForm onDone={() => setAdding(false)} />
        ) : (
          <button className="aic-primary aic-add-btn" onClick={() => setAdding(true)} disabled={!connections}>
            {t('aiConnections.addConnection', '+ Add a connection')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
