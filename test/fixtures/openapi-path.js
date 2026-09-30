import { fileURLToPath } from "node:url";

export const OPENAPI_PATH = fileURLToPath(new URL("../../openapi/datalog-services.v1.yaml", import.meta.url));
