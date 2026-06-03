interface LinearLabel {
    name: string;
}
interface LinearState {
    name: string;
    type: string;
}
interface LinearCycle {
    name: string;
}
interface LinearAssignee {
    name: string | null;
    email: string | null;
}
interface LinearIssue {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    priority: number;
    state: LinearState;
    labels: {
        nodes: LinearLabel[];
    };
    dueDate: string | null;
    cycle: LinearCycle | null;
    assignee?: LinearAssignee | null;
    url?: string | null;
}
export declare function parseStatusMap(raw: string | undefined): Record<string, string>;
export declare function resolveStatus(stateType: string, stateName: string, statusMap: Record<string, string>): string;
export declare function invertStatusMap(statusMap: Record<string, string>): Record<string, string>;
export declare function resolveLinearStateName(pmStatus: string | undefined, invertedMap: Record<string, string>): string | undefined;
export declare function parseFieldMap(raw: string | undefined): Record<string, string>;
export declare function fieldIsIgnored(fieldMap: Record<string, string>, linearField: string): boolean;
export declare function resolvePmField(fieldMap: Record<string, string>, linearField: string): string;
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
    updatedSince?: boolean;
}
export declare function buildIssuesQuery(flags: IssueFilterFlags): string;
export interface ImportRequestPlan {
    endpoint: string;
    method: "POST";
    query: string;
    variables: Record<string, unknown>;
}
export declare function buildImportRequestPlan(team: string, limit: number, filters?: FetchFilters, after?: string | null): ImportRequestPlan;
interface FetchFilters {
    project?: string;
    assignee?: string;
    label?: string;
    updatedSince?: string;
}
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
export interface ItemPlan {
    title: string;
    body: string;
    status: string;
    priority: number;
    tags: string[];
    deadline?: string;
    description: string;
}
export declare function buildItemPlan(issue: LinearIssue, statusMap: Record<string, string>, fieldMap?: Record<string, string>): ItemPlan;
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
export interface ExportMutationPlan {
    action: "create" | "update";
    mutation: string;
    variables: Record<string, unknown>;
    targetStateName: string | null;
}
export declare function buildExportMutationPlan(payload: LinearCreatePayload, invertedStatusMap: Record<string, string>, teamKey?: string): ExportMutationPlan;
export declare function maskApiKey(key: string | undefined): string;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map