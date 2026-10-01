import type { AgentSession } from "../../session/agent-session";
import type { ClmReadTarget } from "../../session/clm-types";
import { errorMessage, parseSubcommand } from "./parse";

export type ContextCommand = { action: "read"; target: ClmReadTarget } | { action: "restore"; revision: string };

export function parseContextCommand(args: string): ContextCommand {
	const { verb, rest } = parseSubcommand(args);
	switch (verb) {
		case "":
		case "status":
		case "show":
		case "history":
			if (!rest) {
				return { action: "read", target: { kind: verb === "show" ? "document" : verb || "status" } };
			}
			break;
		case "diff":
		case "restore":
			if (rest && !/\s/.test(rest)) {
				return verb === "restore"
					? { action: "restore", revision: rest }
					: { action: "read", target: { kind: "diff", revision: rest } };
			}
			break;
	}
	throw new Error("Usage: /context [status|show|history|diff REV|restore REV]");
}

export async function runContextCommand(
	session: Pick<AgentSession, "getClmContext" | "restoreClmContext">,
	args: string,
): Promise<string> {
	try {
		const command = parseContextCommand(args);
		return command.action === "restore"
			? await session.restoreClmContext(command.revision)
			: await session.getClmContext().read(command.target);
	} catch (error) {
		return errorMessage(error);
	}
}
