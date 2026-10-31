// Vue 3 adapter: app plugin (errorHandler / warnHandler, $ray, provide) and useRay() composable.
// Reactive proxies are unwrapped with toRaw before serialization, so dumps never touch reactivity.
import { ray, type Ray } from '@thewonderjoy/gaze-js';
import { getCurrentInstance, toRaw, unref, watch, type App, type ComponentInternalInstance, type WatchSource } from 'vue';

export interface RayPluginOptions {
  /** Send component errors to the app (default true). The previous handler still runs. */
  errors?: boolean;
  /** Send Vue warnings (dev builds only; default false). */
  warnings?: boolean;
}

const con = globalThis.console;
const name = (i?: ComponentInternalInstance | null): string | undefined => (i?.type as { name?: string; __name?: string })?.name ?? (i?.type as { __name?: string })?.__name;
const raw = (v: unknown): unknown => toRaw(unref(v));

export const RayPlugin = {
  install(app: App, o: RayPluginOptions = {}): void {
    app.config.globalProperties.$ray = ray;
    app.provide('ray', ray);
    if (o.errors !== false) {
      const prev = app.config.errorHandler;
      app.config.errorHandler = (err, inst, info) => {
        ray().exception(err, { info, component: name(inst?.$) });
        // Vue only logs when no handler is set; keep that behaviour visible.
        prev ? prev(err, inst, info) : con.error(err);
      };
    }
    if (o.warnings) {
      const prev = app.config.warnHandler;
      app.config.warnHandler = (msg, inst, trace) => {
        ray().text(`${msg}${trace}`).label('vue warn').orange();
        prev ? prev(msg, inst, trace) : con.warn(`[Vue warn]: ${msg}${trace}`);
      };
    }
  },
};

export interface UseRay {
  ray: typeof ray;
  /** Dump the component's props. */
  props(): Ray;
  /** Re-send a ref/getter/reactive object to one entry whenever it changes. Returns the stop handle. */
  watch(source: WatchSource | object, label?: string): () => void;
  /** Dump a template ref's element. */
  element(el: unknown): Ray;
}

export function useRay(): UseRay {
  const inst = getCurrentInstance();
  return {
    ray,
    props: () => ray(raw(inst?.props)).label(`${name(inst) ?? 'component'} props`),
    watch(source, label) {
      const r = ray();
      if (label) r.label(label);
      return watch(source as WatchSource, (v) => r.send(raw(v)), { deep: true, immediate: true });
    },
    element: (el) => ray(raw(el)),
  };
}

export { ray };
