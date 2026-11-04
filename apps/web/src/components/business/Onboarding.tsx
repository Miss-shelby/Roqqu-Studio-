/**
 * Onboarding and sign-in. New owners give four things (name, business name,
 * email, password) and are in; a Roqqu wallet on every network is created
 * behind the scenes. Returning owners sign in with email + password.
 */
"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import { bizPost, useBusiness } from "./useBusiness";

function PasswordField({
  value,
  onChange,
  autoComplete,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: "new-password" | "current-password";
  hint?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className="svc-field">
      <span>Password</span>
      <span className="ob-pass">
        <input
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={autoComplete === "new-password" ? 8 : undefined}
        />
        <button type="button" className="svc-link" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
          {shown ? "Hide" : "Show"}
        </button>
      </span>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function Onboarding() {
  const { refresh } = useBusiness();
  const [mode, setMode] = useState<"create" | "signin">("create");
  const [form, setForm] = useState({ owner_name: "", business_name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") await bizPost("/api/biz/onboard", form);
      else await bizPost("/api/biz/login", { email: form.email, password: form.password });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const switchTo = (next: "create" | "signin") => {
    setMode(next);
    setError(null);
    setForm((f) => ({ ...f, password: "" }));
  };

  return (
    <div className="ob">
      <div className="ob-card">
        <Image src="/figma/roqqu-logo.svg" alt="" width={36} height={36} />
        <h1>{mode === "create" ? "Set up your business" : "Sign in"}</h1>
        <p className="ob-lead">
          {mode === "create"
            ? "Your name and business name go on every invoice and on your store. We create your Roqqu wallets for you."
            : "Welcome back. Sign in with the email and password you set up with."}
        </p>
        <form onSubmit={submit} className="ob-form">
          {mode === "create" ? (
            <>
              <label className="svc-field">
                <span>Your name</span>
                <input autoComplete="name" value={form.owner_name} onChange={set("owner_name")} placeholder="Ada Obi" required minLength={2} maxLength={80} autoFocus />
              </label>
              <label className="svc-field">
                <span>Business name</span>
                <input autoComplete="organization" value={form.business_name} onChange={set("business_name")} placeholder="Ada's Kitchen" required minLength={2} maxLength={80} />
              </label>
            </>
          ) : null}
          <label className="svc-field">
            <span>Email</span>
            <input type="email" autoComplete="email" value={form.email} onChange={set("email")} placeholder="ada@example.com" required autoFocus={mode === "signin"} />
          </label>
          <PasswordField
            value={form.password}
            onChange={(password) => setForm({ ...form, password })}
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            hint={mode === "create" ? "At least 8 characters. You also use it to confirm sending crypto." : undefined}
          />
          <button className="svc-btn svc-btn--primary ob-submit" disabled={busy}>
            {busy ? (mode === "create" ? "Creating your business…" : "Signing in…") : mode === "create" ? "Create my business" : "Sign in"}
          </button>
        </form>
        <p className="ob-switch">
          {mode === "create" ? (
            <>Already set up? <button type="button" className="svc-link" onClick={() => switchTo("signin")}>Sign in</button></>
          ) : (
            <>New here? <button type="button" className="svc-link" onClick={() => switchTo("create")}>Set up a business</button></>
          )}
        </p>
        {error ? <div className="svc-notice is-bad" role="alert">{error}</div> : null}
      </div>
    </div>
  );
}
