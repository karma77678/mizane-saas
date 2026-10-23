import { Router, type IRouter } from "express";
import healthRouter from "./health";
import auditAiRouter from "./audit-ai";
import authRouter from "./auth";
import workspacesRouter from "./workspaces";
import auditDataRouter from "./audit-data";
import auditAiCorrectionRouter from "./audit-ai-correction";
import auditSemanticRouter from "./audit-semantic";
import aiUsageRouter from "./ai-usage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(workspacesRouter);
router.use(auditDataRouter);
router.use(auditAiRouter);
router.use(auditAiCorrectionRouter);
router.use(auditSemanticRouter);
router.use(aiUsageRouter);

export default router;
