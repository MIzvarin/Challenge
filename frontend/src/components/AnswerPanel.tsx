import type { Answer } from '../api';

interface AnswerPanelProps {
  response: Answer | null;
  isSubmitting: boolean;
  error: string | null;
}

export function AnswerPanel({ response, isSubmitting, error }: AnswerPanelProps) {
  return (
    <section className="answer-panel" aria-labelledby="answer-heading" aria-busy={isSubmitting}>
      <div className="field-heading">
        <h2 id="answer-heading">Ответ</h2>
        {response && <span className="model-name">{response.model}</span>}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {isSubmitting && (
          <p className="loading"><span className="loading-dot" aria-hidden="true" />Получаем ответ…</p>
        )}
        {!isSubmitting && response && (
          <>
            <div className="answer-text">{response.answer}</div>
            {response.truncated && <p className="answer-note">Достигнут лимит длины ответа. Попробуйте задать более узкий вопрос.</p>}
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
