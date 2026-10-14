import {
  type FactoryConfig,
  type FactoryConfigFile,
  type PlanningConfig,
  readConfigFile,
  resolveProvider,
} from "./config.js";
import {
  continuationConfigurationMatches,
  readContinuation,
} from "./state-store.js";

/** Why a command runs with its provider; status reports it. */
export type ProviderSource = "objective" | "flag" | "host" | "default";

export interface SelectedConfig {
  config: FactoryConfig;
  provider: string;
  source: ProviderSource;
}

/**
 * The planning provider kind of the agent host running this command, from the variable each
 * host sets on the shells it starts: `CLAUDECODE=1` (Claude Code) or `CODEX_THREAD_ID`
 * (Codex). Children inherit them, so a shell carrying both is ambiguous and selects nothing.
 */
export function hostPlanningKind(
  env: NodeJS.ProcessEnv = process.env,
): PlanningConfig["kind"] | "ambiguous" | undefined {
  const claude = env.CLAUDECODE === "1",
    codex = !!env.CODEX_THREAD_ID;
  if (claude && codex) return "ambiguous";
  return claude ? "claude-agent-sdk" : codex ? "codex-sdk" : undefined;
}

/**
 * Choose one provider: an Objective with state keeps the provider it froze (or the default
 * when none matches, so it stays inspectable); otherwise an
 * explicit `--provider`, then the calling host's provider, then `defaultProvider`. Queue and
 * service commands pass `host: false`, because the service has one provider for new work.
 */
export function selectProvider(
  file: FactoryConfigFile,
  options: {
    objective?: number;
    flag?: string;
    host?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): SelectedConfig {
  const names = Object.keys(file.providers);
  if (options.objective !== undefined) {
    const state = readContinuation(file.repository, options.objective);
    if (state) {
      const provider = names.find((name) =>
        continuationConfigurationMatches(state, resolveProvider(file, name)),
      );
      // A configuration no provider matches keeps today's single-configuration behavior:
      // inspection works, and continuation refuses where it requires the frozen digest.
      if (provider === undefined)
        return {
          config: resolveProvider(file, file.defaultProvider),
          provider: file.defaultProvider,
          source: "default",
        };
      if (options.flag !== undefined && options.flag !== provider)
        throw new Error(
          `Objective #${options.objective} runs with provider ${provider}; --provider cannot switch started work`,
        );
      return {
        config: resolveProvider(file, provider),
        provider,
        source: "objective",
      };
    }
  }
  if (options.flag !== undefined)
    return {
      config: resolveProvider(file, options.flag),
      provider: options.flag,
      source: "flag",
    };
  const kind =
    options.host === false ? undefined : hostPlanningKind(options.env);
  if (kind === "ambiguous")
    throw new Error(
      "This shell carries both Claude Code and Codex host markers; choose a provider with --provider NAME",
    );
  if (kind) {
    const matching = names.filter(
      (name) => file.providers[name]!.planning.kind === kind,
    );
    const provider = matching.includes(file.defaultProvider)
      ? file.defaultProvider
      : matching.length === 1
        ? matching[0]
        : undefined;
    if (!provider)
      throw new Error(
        matching.length
          ? `This agent host matches providers ${matching.join(", ")}; choose one with --provider NAME`
          : `This agent host plans with ${kind}, and no provider uses it; add one with factory setup --config-only --provider NAME --planning ${kind} …, or choose another with --provider NAME`,
      );
    return {
      config: resolveProvider(file, provider),
      provider,
      source: "host",
    };
  }
  return {
    config: resolveProvider(file, file.defaultProvider),
    provider: file.defaultProvider,
    source: "default",
  };
}

export function readSelectedConfig(
  path: string,
  options: Parameters<typeof selectProvider>[1] = {},
): SelectedConfig {
  return selectProvider(readConfigFile(path), options);
}
