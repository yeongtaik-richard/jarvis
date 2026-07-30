import { config } from 'dotenv'
config({ path: '/Users/lambda256/git/jarvis/.env.local' })
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
const reqs = await sql`select ts, method, path, status from request_logs
  where ts > timestamptz '2026-07-30T05:21:00Z' and user_agent like 'curl%' order by ts limit 20`
console.log('클라우드 요청:', reqs)
const br: any = await sql`select id, kind, title, body, array_length(input_snapshot_ids,1) ids
  from stock_analysis where authored_by='claude-routine' order by created_at desc limit 1`
console.log('브리핑:', br[0] ? { id: br[0].id, kind: br[0].kind, title: br[0].title, ids: br[0].ids } : '(없음)')
if (br[0]) console.log('\n--- body ---\n' + br[0].body)
console.log('개선노트:', await sql`select missing_capability, proposed_fix from improvement_notes
  where created_at > now() - interval '15 minutes'`)
