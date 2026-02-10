// client/src/lib/utils.ts

export type ClassValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ClassValue[]
  | { [key: string]: any };

export function cn(...inputs: ClassValue[]) {
  const classes: string[] = [];

  const push = (value: ClassValue) => {
    if (!value) return;

    if (typeof value === "string" || typeof value === "number") {
      classes.push(String(value));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }

    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        if ((value as any)[key]) classes.push(key);
      }
    }
  };

  inputs.forEach(push);

  return classes.join(" ");
}
