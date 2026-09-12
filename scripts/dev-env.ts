const localHosts = "127.0.0.1,localhost,::1";

export function withLocalNoProxy<T extends Record<string, string | undefined>>(
  env: T = process.env as T,
) {
  const current = [env.NO_PROXY, env.no_proxy, localHosts]
    .filter(Boolean)
    .join(",");
  return { ...env, NO_PROXY: current, no_proxy: current };
}
