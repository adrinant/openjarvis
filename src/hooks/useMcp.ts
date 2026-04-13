import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export function useMcp() {
  const [servers, setServers] = useState<unknown[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<unknown[]>("get_mcp_servers");
      setServers(list);
    } catch {
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { servers, refresh };
}
