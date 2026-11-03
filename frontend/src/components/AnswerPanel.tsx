import type { ReactElement } from 'react';
import type { Answer } from '../api';

interface AnswerPanelProps {
  response: Answer | null;
  isSubmitting: boolean;
  error: string | null;
}

export function AnswerPanel({ response, isSubmitting, error }: AnswerPanelProps): ReactElement {
  return (
    <section className="answer-panel" aria-labelledby="answer-heading" aria-busy={isSubmitting}>
      <div className="field-heading">
        <h2 id="answer-heading">Ответ</h2>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {isSubmitting && (
          <p className="loading"><span className="loading-dot" aria-hidden="true" />Получаем ответ…</p>
        )}
        {!isSubmitting && response && (
          <>
            <p className="answer-question">{response.question}</p>
            <div className="answer-metadata">
              <time dateTime={response.date}>
                {new Date(response.date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
              </time>
              <span>Токенов потрачено: {response.tokens}</span>
            </div>
            <div className="answer-text">{response.answer}</div>
          </>
        )}
        {!isSubmitting && !response && !error && (
          <p className="empty-answer">Пока здесь тихо. Задайте первый вопрос.</p>
        )}
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
    </section>
  );
}
