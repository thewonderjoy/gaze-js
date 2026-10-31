// React adapter: useRay() (one entry updated in place as the value changes), <RayBoundary> for any
// React version, and rayRootOptions() for React 19 createRoot error callbacks (componentStack).
import { ray, type Ray } from '@thewonderjoy/gaze-js';
import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';

export interface UseRayOptions {
  label?: string;
  /** Explicit entry id (default: one id per component instance). */
  id?: string;
}

/** Send `value` whenever it changes (Object.is), always to the same entry. */
export function useRay(value: unknown, o: UseRayOptions = {}): Ray {
  const r = useRef<Ray | null>(null);
  r.current ??= o.id ? ray.at(o.id) : ray();
  useEffect(() => {
    const x = r.current!.send(value);
    if (o.label) x.label(o.label);
  }, [value]);
  return r.current;
}

interface BoundaryProps {
  children?: ReactNode;
  /** Rendered after an error (default: nothing). */
  fallback?: ReactNode;
  label?: string;
}

export class RayBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('unknown error') };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    ray().exception(error, { componentStack: info.componentStack }).label(this.props.label ?? 'React');
  }
  override render(): ReactNode {
    return this.state.error === undefined ? this.props.children : (this.props.fallback ?? null);
  }
}

type RootCallback = (error: unknown, info: { componentStack?: string }) => void;
export interface RootErrorOptions {
  onUncaughtError?: RootCallback;
  onCaughtError?: RootCallback;
  onRecoverableError?: RootCallback;
}

const G = globalThis as { reportError?: (e: unknown) => void; console: Console };

/**
 * `createRoot(el, rayRootOptions())`: reports uncaught, caught and recoverable errors with their
 * component stack, then calls your callbacks (or React's default reporting) as before.
 */
export function rayRootOptions(o: RootErrorOptions = {}): Required<RootErrorOptions> {
  const wrap = (kind: string, next: RootCallback | undefined, fallback: (e: unknown) => void): RootCallback =>
    (error, info) => {
      ray().exception(error, { kind, componentStack: info?.componentStack }).label('React');
      next ? next(error, info) : fallback(error);
    };
  return {
    onUncaughtError: wrap('uncaught', o.onUncaughtError, (e) => (G.reportError ? G.reportError(e) : G.console.error(e))),
    onCaughtError: wrap('caught', o.onCaughtError, (e) => G.console.error(e)),
    onRecoverableError: wrap('recoverable', o.onRecoverableError, (e) => G.console.error(e)),
  };
}

export { ray };
