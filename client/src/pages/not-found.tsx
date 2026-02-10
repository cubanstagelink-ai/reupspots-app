import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">404</h1>
        <p className="mt-2">Page not found</p>
        <Link href="/">
          <a className="underline mt-4 inline-block">Go home</a>
        </Link>
      </div>
    </div>
  );
}
