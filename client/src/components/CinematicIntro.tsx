import { useEffect } from "react";

export function CinematicIntro({
  onComplete,
}: {
  onComplete: () => void;
}) {
  useEffect(() => {
    // auto-finish intro quickly so app loads
    const t = setTimeout(() => onComplete(), 300);
    return () => clearTimeout(t);
  }, [onComplete]);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
      <div className="text-lg font-semibold">Loading…</div>
    </div>
  );
}
