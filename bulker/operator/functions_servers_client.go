package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// FunctionsServerRecord represents a record in the FunctionsServer table
type FunctionsServerRecord struct {
	WorkspaceID      string
	Class            string
	DeploymentID     string
	Connections      []string
	EmptyConnections []string
	ShutdownAt       *time.Time
}

// FunctionsServerDB handles direct PostgreSQL operations for the FunctionsServer table
type FunctionsServerDB struct {
	dbpool *pgxpool.Pool
}

// NewFunctionsServerDB creates a new FunctionsServer database client
func NewFunctionsServerDB(dbpool *pgxpool.Pool) *FunctionsServerDB {
	return &FunctionsServerDB{dbpool: dbpool}
}

// ReplaceRecordsForDeployment atomically replaces all FunctionsServer records for a deployment.
// In a transaction: deletes all existing records for the deploymentId, then inserts new ones.
func (db *FunctionsServerDB) ReplaceRecordsForDeployment(deploymentID string, records []FunctionsServerRecord) error {
	ctx := context.Background()
	tx, err := db.dbpool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx)

	// Delete all existing records for this deployment
	_, err = tx.Exec(ctx,
		`DELETE FROM newjitsu."FunctionsServer" WHERE "deploymentId" = $1`,
		deploymentID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete records for deployment %s: %v", deploymentID, err)
	}

	// Insert new records
	for _, r := range records {
		_, err = tx.Exec(ctx,
			`INSERT INTO newjitsu."FunctionsServer" ("workspaceId", "class", "deploymentId", "connections", "emptyConnections", "createdAt", "updatedAt", "shutdownAt")
			 VALUES ($1, $2, $3, $4, $5, now(), now(), $6)
			 ON CONFLICT ("workspaceId", "class") DO UPDATE SET
			     "deploymentId" = EXCLUDED."deploymentId",
			     "connections" = EXCLUDED."connections",
			     "emptyConnections" = EXCLUDED."emptyConnections",
			     "updatedAt" = now(),
			     "shutdownAt" = EXCLUDED."shutdownAt"`,
			r.WorkspaceID,
			r.Class,
			r.DeploymentID,
			r.Connections,
			r.EmptyConnections,
			r.ShutdownAt,
		)
		if err != nil {
			return fmt.Errorf("failed to insert FunctionsServer record for workspace %s class %s: %v",
				r.WorkspaceID, r.Class, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %v", err)
	}
	return nil
}

// DeleteRecordsForDeployment deletes all FunctionsServer records for a deployment
func (db *FunctionsServerDB) DeleteRecordsForDeployment(deploymentID string) error {
	ctx := context.Background()
	_, err := db.dbpool.Exec(ctx,
		`DELETE FROM newjitsu."FunctionsServer" WHERE "deploymentId" = $1`,
		deploymentID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete FunctionsServer records for deployment %s: %v", deploymentID, err)
	}
	return nil
}

// BuildRecordsFromDeploymentData builds FunctionsServer records from deployment data
func BuildRecordsFromDeploymentData(data *DeploymentData) []FunctionsServerRecord {
	records := make([]FunctionsServerRecord, 0, len(data.WorkspaceIDs))

	// Group connections by workspace
	connectionsByWorkspace := make(map[string][]string)
	emptyConnectionsByWorkspace := make(map[string][]string)

	for _, conn := range data.Connections {
		// Check if connection has UDF functions
		hasFunctions := false
		if opts, ok := conn.Options["functions"]; ok {
			if funcs, ok := opts.([]any); ok {
				for _, f := range funcs {
					if fm, ok := f.(map[string]any); ok {
						if fid, ok := fm["functionId"].(string); ok && strings.HasPrefix(fid, "udf.") {
							hasFunctions = true
							break
						}
					}
				}
			}
		}

		if hasFunctions {
			connectionsByWorkspace[conn.WorkspaceID] = append(connectionsByWorkspace[conn.WorkspaceID], conn.ID)
		} else {
			emptyConnectionsByWorkspace[conn.WorkspaceID] = append(emptyConnectionsByWorkspace[conn.WorkspaceID], conn.ID)
		}
	}

	for _, wsID := range data.WorkspaceIDs {
		record := FunctionsServerRecord{
			WorkspaceID:      wsID,
			Class:            data.FunctionsClass,
			DeploymentID:     data.DeploymentID,
			Connections:      connectionsByWorkspace[wsID],
			EmptyConnections: emptyConnectionsByWorkspace[wsID],
		}
		if record.Connections == nil {
			record.Connections = []string{}
		}
		if record.EmptyConnections == nil {
			record.EmptyConnections = []string{}
		}
		records = append(records, record)
	}

	return records
}
