import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../store/auth";

export function SignIn() {
  const { signin } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signin(email, password);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your pillbox.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password" value={password} onChange={setPassword} type="password" />
        {error && <p className="text-lowStockRed text-sm">{error}</p>}
        <button type="submit" disabled={busy} className="brand-btn py-3 mt-2 disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="text-center text-sm text-textSecondary mt-4">
        No account?{" "}
        <Link to="/signup" className="text-forestGreen font-semibold">
          Sign up
        </Link>
      </p>
    </AuthShell>
  );
}

export function SignUp() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signup(email, password);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="Your medications are saved to your account.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password" value={password} onChange={setPassword} type="password" hint="At least 6 characters" />
        {error && <p className="text-lowStockRed text-sm">{error}</p>}
        <button type="submit" disabled={busy} className="brand-btn py-3 mt-2 disabled:opacity-60">
          {busy ? "Creating…" : "Sign up"}
        </button>
      </form>
      <p className="text-center text-sm text-textSecondary mt-4">
        Already have an account?{" "}
        <Link to="/signin" className="text-forestGreen font-semibold">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-5">
      <div className="neumorphic-card w-full max-w-sm p-7">
        <div className="text-3xl mb-1">💊</div>
        <h1 className="text-xl font-bold text-textPrimary">{title}</h1>
        <p className="text-textSecondary text-sm mb-6">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-textPrimary">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="neumorphic-inset px-4 py-3 outline-none text-textPrimary"
        required
      />
      {hint && <span className="text-xs text-textSecondary">{hint}</span>}
    </label>
  );
}
