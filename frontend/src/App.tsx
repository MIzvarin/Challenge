import { useState } from 'react';
import type { ReactElement } from 'react';
import { AnswerPanel } from './components/AnswerPanel';
import { QuestionForm } from './components/QuestionForm';
import { EffortTabs, ModeTabs, TemperatureTabs } from './components/Tabs';
import { WorkspaceMenu } from './components/WorkspaceMenu';
import type { ConversationScope } from './conversation-scope';
import { MODE_DESCRIPTIONS, MODE_LABELS, WORKSPACE_LABELS } from './modes';
import type { Effort, Mode, Temperature, Workspace } from './modes';
import { useConversationController } from './use-conversation-controller';

export function App(): ReactElement {
  const [mode, setMode] = useState<Mode>('direct');
  const [effort, setEffort] = useState<Effort>('low');
  const [temperature, setTemperature] = useState<Temperature>(0.7);
  const [workspace, setWorkspace] = useState<Workspace>('reasoning');
  const scope: ConversationScope = workspace === 'reasoning'
    ? { workspace, effort, mode } : { workspace, temperature, mode: 'direct' };
  const { turns, question, storageWarning, isClearing, isSubmitting, updateDraft, handleSubmit, clearHistory } = useConversationController(scope);
  const panel = workspace === 'reasoning' ? mode : `temperature-${temperature}`;

  const conversation = (
    <div
      className={`workspace${scope.mode === 'compare' ? ' workspace-comparison' : ''}`}
      role="tabpanel"
      id={`panel-${panel}`}
      aria-labelledby={`tab-${panel}`}
      tabIndex={0}
    >
      {workspace === 'temperature' && <p className="temperature-description">Рассуждения отключены · temperature = <strong>{temperature}</strong>.</p>}
      <div className="intro">
        <p className="eyebrow">АЛГОРИТМЫ И АНАЛИТИКА</p>
        <h1>{MODE_LABELS[scope.mode]}</h1>
        <p className="subtitle">{MODE_DESCRIPTIONS[scope.mode]}</p>
        <p className="context-note">
          {workspace === 'reasoning' ? 'Отдельный диалог для каждой пары «рассуждения / подход».' : 'Отдельный диалог для каждой температуры.'}
          {' '}Предыдущая переписка передаётся модели.
        </p>
      </div>
      {storageWarning && <p className="storage-warning" role="alert">{storageWarning}</p>}
      <AnswerPanel turns={turns} />
      <QuestionForm question={question} isSubmitting={isSubmitting} onQuestionChange={updateDraft} onSubmit={handleSubmit} />
    </div>
  );

  return (
    <main className="page">
      <header className="page-header">
        <div className="header-start">
          <WorkspaceMenu selected={workspace} onSelect={setWorkspace} />
          <a className="brand" href="/" aria-label="Challenge — на главную">challenge<span aria-hidden="true"> / </span>ai</a>
          <span className="workspace-name">{WORKSPACE_LABELS[workspace]}</span>
        </div>
        <button className="clear-history" type="button" onClick={clearHistory} disabled={isClearing}>Очистить историю</button>
      </header>
      {workspace === 'reasoning' ? (
        <>
          <EffortTabs selected={effort} onSelect={setEffort} />
          <div role="tabpanel" id={`panel-effort-${effort}`} aria-labelledby={`tab-effort-${effort}`} tabIndex={0}>
            <p className="effort-description">
              Рассуждения включены · effort = <strong>{effort}</strong>.
              {' '}{effort === 'max' ? 'Больше времени и расхода токенов.' : 'Минимальная поддерживаемая интенсивность.'}
            </p>
            <ModeTabs selected={mode} onSelect={setMode} />
            {conversation}
          </div>
        </>
      ) : (
        <>
          <TemperatureTabs selected={temperature} onSelect={setTemperature} />
          {conversation}
        </>
      )}
      <footer className="page-footer">
        <span>История хранится только в этом браузере. Очистка удаляет все диалоги обоих разделов.</span>
        <span>Вопрос и история отправляются внешнему ИИ-сервису. Не указывайте секреты — ИИ может ошибаться.</span>
      </footer>
    </main>
  );
}
