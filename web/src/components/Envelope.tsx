import { useEffect, useState, type ReactNode } from 'react';

interface EnvelopeProps {
  /** closed: sealed; open: plays the opening once; peek: drawn already open (no animation). */
  state: 'closed' | 'open' | 'peek';
  message?: ReactNode;
  sub?: ReactNode;
  pill?: ReactNode;
  /** What the letter inside shows once open. */
  letter?: ReactNode;
  seal?: string;
  label?: string;
}

/**
 * The red packet. The opening (flap lifts, seal fades, letter rises) is pure CSS
 * and is switched off under prefers-reduced-motion in styles.css. When mounted
 * straight into "open" it starts closed for two frames so the opening still plays.
 */
export function Envelope({ state, message, sub, pill, letter, seal = '福', label }: EnvelopeProps) {
  const [shown, setShown] = useState<EnvelopeProps['state']>(state === 'open' ? 'closed' : state);
  useEffect(() => {
    if (state !== 'open') {
      setShown(state);
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown('open'));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [state]);
  const cls = shown === 'closed' ? '' : shown;
  return (
    <div className={`env-stage ${shown === 'open' ? 'open' : shown === 'peek' ? 'peek' : ''}`}>
      <div className={`env ${cls}`} role="img" aria-label={label}>
        <div className="env-back" />
        <div className="env-letter" aria-hidden={shown === 'closed'}>
          {letter}
        </div>
        <div className="env-front">
          <div className="env-body">
            {message ? <div className="env-message">{message}</div> : null}
            {sub ? <div className="env-sub">{sub}</div> : null}
            {pill ? <div className="env-pill">{pill}</div> : null}
          </div>
        </div>
        <div className="env-flap">
          <div className="env-flap-rim" />
          <div className="env-flap-face" />
        </div>
        <div className="env-seal" aria-hidden>
          {seal}
        </div>
      </div>
    </div>
  );
}
