/** Unknown /api/* paths answer JSON 404 instead of falling through to the SPA. */
import { json } from "../_lib/http";

export const onRequest: PagesFunction = () => json({ error: "NotFound", message: "Not found." }, 404);
