// client/src/hooks/use-toast.ts
import * as React from "react";

type ToastVariant = "default" | "destructive";

export type Toast = {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
};

type ToastState = {
  toasts: Toast[];
};

type ToastAction =
  | { type: "ADD_TOAST"; toast: Toast }
  | { type: "DISMISS_TOAST"; toastId?: string }
  | { type: "REMOVE_TOAST"; toastId?: string };

const TOAST_LIMIT = 1;
const TOAST_REMOVE_DELAY = 1000;

let count = 0;
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

let state: ToastState = { toasts: [] };
const listeners = new Set<(s: ToastState) => void>();
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

function notify() {
  for (const l of listeners) l(state);
}

function dispatch(action: ToastAction) {
  switch (action.type) {
    case "ADD_TOAST": {
      state = { toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT) };
      notify();
      return;
    }

    case "DISMISS_TOAST": {
      const { toastId } = action;

      const ids = toastId ? [toastId] : state.toasts.map((t) => t.id);
      ids.forEach((id) => {
        if (timeouts.has(id)) return;
        const timeout = setTimeout(() => {
          dispatch({ type: "REMOVE_TOAST", toastId: id });
        }, TOAST_REMOVE_DELAY);
        timeouts.set(id, timeout);
      });

      notify();
      return;
    }

    case "REMOVE_TOAST": {
      const { toastId } = action;
      if (!toastId) {
        state = { toasts: [] };
      } else {
        state = { toasts: state.toasts.filter((t) => t.id !== toastId) };
      }
      notify();
      return;
    }
  }
}

export function toast(input: Omit<Toast, "id">) {
  const id = genId();

  const t: Toast = {
    id,
    duration: 3000,
    variant: "default",
    ...input,
  };

  dispatch({ type: "ADD_TOAST", toast: t });

  if (t.duration && t.duration > 0) {
    if (timeouts.has(id)) clearTimeout(timeouts.get(id)!);
    const timeout = setTimeout(() => {
      dispatch({ type: "DISMISS_TOAST", toastId: id });
    }, t.duration);
    timeouts.set(id, timeout);
  }

  return {
    id,
    dismiss: () => dispatch({ type: "DISMISS_TOAST", toastId: id }),
    update: (next: Partial<Omit<Toast, "id">>) => {
      const existing = state.toasts.find((x) => x.id === id);
      if (!existing) return;
      dispatch({
        type: "ADD_TOAST",
        toast: { ...existing, ...next, id },
      });
    },
  };
}

export function useToast() {
  const [localState, setLocalState] = React.useState<ToastState>(state);

  React.useEffect(() => {
    listeners.add(setLocalState);
    return () => {
      listeners.delete(setLocalState);
    };
  }, []);

  return {
    toasts: localState.toasts,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}
