export declare function parseStatusMap(raw: string | undefined): Record<string, string>;
export declare function resolveStatus(stateType: string, stateName: string, statusMap: Record<string, string>): string;
export declare function invertStatusMap(statusMap: Record<string, string>): Record<string, string>;
export declare function resolveLinearStateName(pmStatus: string | undefined, invertedMap: Record<string, string>): string | undefined;
export declare function buildProvenance(issue: {
    id: string;
    identifier: string;
    url?: string | null;
}): string;
export declare function parseProvenance(description: string | undefined): {
    linear_id: string;
    linear_url: string;
} | undefined;
export interface IssueFilterFlags {
    project?: boolean;
    assignee?: boolean;
    label?: boolean;
}
export declare function buildIssuesQuery(flags: IssueFilterFlags): string;
export declare function backoffDelayMs(attempt: number, retryAfterMs?: number): number;
interface PmItem {
    id?: string;
    title?: string;
    status?: string;
    body?: string;
    description?: string;
    priority?: number;
    tags?: string[];
}
export declare function indexItemsByLinearId(items: PmItem[]): Record<string, PmItem>;
interface LinearCreatePayload {
    title: string;
    description: string;
    pmId?: string;
    pmStatus?: string;
    alreadyInLinear: boolean;
    linearId?: string;
    linearUrl?: string;
}
export declare function itemToLinearPayload(item: PmItem): LinearCreatePayload;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map