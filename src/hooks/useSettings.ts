import useSWR from "swr";
import { QUICK_OPEN_EDITOR_IDS } from "@/lib/types";

interface AppOption {
  id: string;
  label?: string;
  installed: boolean;
}

interface SettingsResponse {
  config: {
    notifications: boolean;
    notificationSound: boolean;
    alwaysNotify: boolean;
    editor: string;
    gitGui: string;
    staleThresholdMinutes: number;
    cleanupCloseTabs: boolean;
  };
  options: {
    editors: AppOption[];
    gitGuis: AppOption[];
  };
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function isAppAvailable(options: AppOption[] | undefined, selectedId: string | undefined): boolean {
  if (!options || !selectedId || selectedId === "none") return false;
  return options.find((o) => o.id === selectedId)?.installed ?? false;
}

export const DEFAULT_STALE_THRESHOLD_MINUTES = 90;

export function useSettings() {
  const { data } = useSWR<SettingsResponse>("/api/settings", fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  return {
    notifications: data?.config?.notifications ?? true,
    notificationSound: data?.config?.notificationSound ?? true,
    alwaysNotify: data?.config?.alwaysNotify ?? false,
    staleThresholdMinutes: data?.config?.staleThresholdMinutes ?? DEFAULT_STALE_THRESHOLD_MINUTES,
    cleanupCloseTabs: data?.config?.cleanupCloseTabs ?? false,
    editorAvailable: isAppAvailable(data?.options?.editors, data?.config?.editor),
    gitGuiAvailable: isAppAvailable(data?.options?.gitGuis, data?.config?.gitGui),
    editorId: data?.config?.editor ?? null,
    editorLabel: data?.options?.editors?.find((o) => o.id === data?.config?.editor)?.label ?? "Editor",
    gitGuiLabel: data?.options?.gitGuis?.find((o) => o.id === data?.config?.gitGui)?.label ?? "Git GUI",
    /** Installed editors offered as explicit "Open in …" choices */
    quickOpenEditors: (data?.options?.editors ?? []).filter(
      (o) => QUICK_OPEN_EDITOR_IDS.includes(o.id) && o.installed,
    ) as { id: string; label: string; installed: boolean }[],
  };
}
