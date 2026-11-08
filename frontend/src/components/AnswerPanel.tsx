import type { ReactElement } from 'react';
import type { Answer, Result } from '../api';
import { isPendingTurn } from '../conversations';
import type { Turn } from '../conversations';
import { MODEL_LABELS, MODE_LABELS, STAGE_LABELS } from '../modes';
import { formatCost } from '../cost';
import type { Cost } from '../cost';

interface CostMetadataProps {
  cost?: Cost | null;
  total?: boolean;
}

function CostMetadata({ cost, total = false }: CostMetadataProps): ReactElement {
  let label = total ? 'Общая стоимость недоступна' : 'Стоимость недоступна';
  if (cost) {
    const heading = total ? 'Примерная общая стоимость' : 'Примерная стоимость';
    label = `${heading}: ${formatCost(cost.amount)}`;
  }
  return (
    <div className="cost-metadata">
      <p className="answer-metadata">
        {label}
      </p>
    </div>
  );
}

interface ResultPanelProps {
  result: Result;
  comparison: boolean;
}

function generationMetadata(response: Answer): string {
  if (response.model !== undefined) return `Модель: ${MODEL_LABELS[response.model]}`;
  if (response.temperature !== undefined) return `temperature: ${response.temperature} · Рассуждения отключены`;
  return response.effort ? `effort: ${response.effort}` : 'До настройки effort';
}

function ResultPanel({ result, comparison }: ResultPanelProps): ReactElement {
  let heading = 'Ответ';
  if (comparison) heading = MODE_LABELS[result.mode];
  else if (result.mode === 'roles') heading = 'Итог критика';

  return (
    <section className={`result-card${result.error ? ' result-failed' : ''}`} aria-label={MODE_LABELS[result.mode]}>
      <div className="result-heading">
        <h3>{heading}</h3>
        <span className="result-duration">{(result.duration_ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} сек.</span>
      </div>
      <p className="answer-metadata">
        {result.tokens === null ? 'Полный расход токенов неизвестен' : `Токенов потрачено: ${result.tokens.toLocaleString('ru-RU')}`}
      </p>
      <CostMetadata cost={result.cost} />
      {result.answer && <div className="answer-text">{result.answer}</div>}
      {result.error && <p className="error-message" role="alert">{result.error}</p>}
      {result.stages.length > 0 && (
        <div className="stages">
          {result.stages.map((stage) => (
            <details key={stage.name} className="stage">
              <summary>{STAGE_LABELS[stage.name]} <span>{stage.tokens.toLocaleString('ru-RU')} токенов</span></summary>
              <CostMetadata cost={stage.cost} />
              <div className="stage-text">{stage.content}</div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

interface AnswerPanelProps {
  turns: Turn[];
}

export function AnswerPanel({ turns }: AnswerPanelProps): ReactElement {
  const isSubmitting = turns.some(isPendingTurn);
  return (
    <section className="answer-panel" aria-labelledby="conversation-heading" aria-busy={isSubmitting}>
      <div className="field-heading">
        <h2 id="conversation-heading">Переписка</h2>
        <span className="character-count">Вопросов: {turns.length}</span>
      </div>
      {turns.length === 0 && <p className="empty-answer">Задайте первую задачу. История этой вкладки сохранится в браузере.</p>}
      <div className="conversation-turns">
        {turns.map((turn) => {
          const { response, error } = turn;
          const date = response?.date ?? turn.date;
          const comparison = response?.mode === 'compare';
          return (
            <article className="conversation-turn" key={turn.id}>
              <div className="turn-question">
                <span className="eyebrow">ВЫ</span>
                <p className="answer-question">{turn.question}</p>
                <div className="answer-metadata">
                  <time dateTime={date}>
                    {new Date(date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                  </time>
                  {response && <span>{generationMetadata(response)}</span>}
                  {comparison && response.tokens !== null && (
                    <span>Всего токенов: {response.tokens.toLocaleString('ru-RU')}</span>
                  )}
                </div>
                {comparison && <CostMetadata cost={response.cost} total />}
              </div>
              {response && (
                <div className={comparison ? 'comparison-grid' : 'single-result'}>
                  {response.results.map((result) => (
                    <ResultPanel key={result.mode} result={result} comparison={comparison} />
                  ))}
                </div>
              )}
              {isPendingTurn(turn) && (
                <p className="loading" role="status"><span className="loading-dot" aria-hidden="true" />Получаем ответ…</p>
              )}
              {error && <p className="error-message" role="alert">{error}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
