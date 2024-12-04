WITH ranked_tasks AS (
  SELECT
    link."workspaceId",
    workspace.slug AS "workspaceSlug",
    task.sync_id,
    task.started_at,
    ROW_NUMBER() OVER (PARTITION BY link."workspaceId" ORDER BY task.started_at DESC) AS row_number
  FROM newjitsu.source_task task
       LEFT JOIN newjitsu."ConfigurationObjectLink" link ON task.sync_id = link.id
       LEFT JOIN newjitsu."Workspace" workspace ON link."workspaceId" = workspace.id
  WHERE link."workspaceId" IS NOT NULL
)
SELECT
  'all' AS period,
  ranked_tasks."workspaceId",
  ranked_tasks."workspaceSlug",
  COUNT(*) AS runs,
  MAX(ranked_tasks.started_at) AS last_sync,
  COUNT(DISTINCT ranked_tasks.sync_id) AS unique_syncs,
  MAX(CASE WHEN ranked_tasks.row_number = 1 THEN ranked_tasks.sync_id END) AS latest_sync_id
FROM ranked_tasks
GROUP BY period, ranked_tasks."workspaceId", ranked_tasks."workspaceSlug"
ORDER BY period DESC, runs DESC, ranked_tasks."workspaceSlug"