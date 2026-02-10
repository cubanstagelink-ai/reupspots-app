import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-6">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm opacity-80">
        The page you’re looking for doesn’t exist.
      </p>

      <Link href="/">
        <a className="mt-6 underline">Go back home</a>
      </Link>
    </div>
  );
}
