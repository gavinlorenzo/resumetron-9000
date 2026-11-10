import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const TASK = "Resumetron9000";
const MARK = "# resumetron-9000";

export interface ScheduleSpec {
  /** Run every N hours, or once a day at `at`. */
  everyHours?: number;
  at?: string; // HH:MM
  home?: string;
}

/** The command a scheduler should run: this same Node binary and CLI entry point. */
export function runCommand(spec: ScheduleSpec): string {
  const cli = resolve(process.argv[1]);
  const flags = cli.endsWith(".ts") ? "--disable-warning=ExperimentalWarning " : "";
  const home = spec.home ? ` --home "${resolve(spec.home)}"` : "";
  return `"${process.execPath}" ${flags}"${cli}" run${home}`;
}

export function describeSchedule(spec: ScheduleSpec): string {
  const cmd = runCommand(spec);
  if (process.platform === "win32") {
    const when = spec.everyHours ? `/SC HOURLY /MO ${spec.everyHours}` : `/SC DAILY /ST ${spec.at ?? "09:00"}`;
    return `schtasks /Create /F /TN ${TASK} ${when} /TR "${cmd.replace(/"/g, '\\"')}"`;
  }
  const [h, m] = (spec.at ?? "09:00").split(":");
  const cron = spec.everyHours ? `0 */${spec.everyHours} * * *` : `${Number(m)} ${Number(h)} * * *`;
  return `${cron} ${cmd} >> "$HOME/.resumetron/cron.log" 2>&1 ${MARK}`;
}

export function installSchedule(spec: ScheduleSpec): string {
  const line = describeSchedule(spec);
  if (process.platform === "win32") {
    const cmd = runCommand(spec);
    const when = spec.everyHours ? ["/SC", "HOURLY", "/MO", String(spec.everyHours)] : ["/SC", "DAILY", "/ST", spec.at ?? "09:00"];
    execFileSync("schtasks", ["/Create", "/F", "/TN", TASK, ...when, "/TR", cmd], { stdio: "pipe" });
    return line;
  }
  const current = cronLines().filter((l) => !l.includes(MARK));
  execFileSync("crontab", ["-"], { input: [...current, line, ""].join("\n") });
  return line;
}

export function removeSchedule(): void {
  if (process.platform === "win32") {
    execFileSync("schtasks", ["/Delete", "/F", "/TN", TASK], { stdio: "pipe" });
    return;
  }
  const kept = cronLines().filter((l) => !l.includes(MARK));
  execFileSync("crontab", ["-"], { input: [...kept, ""].join("\n") });
}

function cronLines(): string[] {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
