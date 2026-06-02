export declare function parseStatusMap(raw: string | undefined): Record<string, string>;
export declare function resolveStatus(stateType: string, stateName: string, statusMap: Record<string, string>): string;
export declare function buildProvenance(issue: {
    id: string;
    identifier: string;
    url?: string | null;
}): string;
export declare function parseProvenance(description: string | undefined): {
    linear_id: string;
    linear_url: string;
} | undefined;
interface PmItem {
    id?: string;
    title?: string;
    status?: string;
    body?: string;
    description?: string;
    priority?: number;
    tags?: string[];
}
interface LinearCreatePayload {
    title: string;
    description: string;
    pmId?: string;
    alreadyInLinear: boolean;
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