import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { config, copilotEnabled } from "@/lib/config";
import { getPatients } from "@/lib/patients";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const missing = [!config.tpufKey && "TURBOPUFFER_API_KEY", !config.databaseUrl && "APP_DATABASE_URL"].filter(Boolean);
  if (missing.length) {
    return (
      <div className="mx-auto max-w-md p-10 text-sm text-slate">
        <h1 className="mb-2 text-lg font-semibold text-ink">Almost there</h1>
        Add {missing.map((m, i) => <span key={String(m)}>{i ? " and " : ""}<code className="font-mono">{m}</code></span>)} to
        the project&apos;s environment variables and redeploy. The README&apos;s setup section has the steps.
      </div>
    );
  }
  const [patients, jar] = await Promise.all([getPatients(), cookies()]);
  return (
    <AppShell patients={patients} initialPatientId={jar.get("ts_patient")?.value ?? null}
      copilotEnabled={copilotEnabled} readOnly={config.readOnly}>
      {children}
    </AppShell>
  );
}
