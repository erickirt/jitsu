package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// SyncOptions mirrors the relevant fields of webapps/console SyncOptionsType
// (lib/schema/index.ts) — only the parts the load-catalog-state init container
// uses for stream selection.
type SyncOptions struct {
	Streams         map[string]json.RawMessage `json:"streams"`
	DisabledStreams map[string]json.RawMessage `json:"disabledStreams"`
	SchemaChanges   string                     `json:"schemaChanges"`
}

type streamConfigFields struct {
	SyncMode    string `json:"sync_mode"`
	CursorField []any  `json:"cursor_field"`
	TableName   string `json:"table_name"`
}

func (o *SyncOptions) streamConfig(name string) *streamConfigFields {
	raw, ok := o.Streams[name]
	if !ok {
		return nil
	}
	cfg := &streamConfigFields{}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil
	}
	return cfg
}

// ConfiguredCatalog is the shape airbyte source connectors expect on stdin
// when running `read --catalog`. We only model the fields we emit.
type ConfiguredCatalog struct {
	Streams []ConfiguredStream `json:"streams"`
}

type ConfiguredStream struct {
	Stream              json.RawMessage `json:"stream"`
	SyncMode            string          `json:"sync_mode"`
	DestinationSyncMode string          `json:"destination_sync_mode"`
	CursorField         []any           `json:"cursor_field,omitempty"`
}

// SelectStreamsFromCatalog is the Go port of selectStreamsFromCatalog in
// webapps/console/lib/server/sync.ts. Filters the airbyte catalog down to
// the streams the user enabled, applies user overrides, and emits the
// configured-catalog payload.
//
// Behavior mirrors the TS implementation:
//   - schemaChanges in {"streams"} → include any catalog stream that isn't
//     explicitly disabled (auto-include new streams).
//   - Otherwise → include only the streams the user explicitly selected.
//   - If a selected stream has no per-stream sync_mode set, default to
//     "incremental" iff the catalog stream supports it AND any other
//     selected stream is already configured incrementally (the TS heuristic).
//   - destination_sync_mode is fixed at "overwrite" (the TS code does the
//     same — destinations don't currently use this field).
func SelectStreamsFromCatalog(catalogObj map[string]any, opts *SyncOptions) (*ConfiguredCatalog, error) {
	streamsArr, ok := catalogObj["streams"].([]any)
	if !ok {
		return nil, fmt.Errorf("catalog.streams: expected array, got %T", catalogObj["streams"])
	}

	hasIncremental := false
	for _, raw := range opts.Streams {
		var sc streamConfigFields
		if err := json.Unmarshal(raw, &sc); err == nil && sc.SyncMode == "incremental" {
			hasIncremental = true
			break
		}
	}

	out := &ConfiguredCatalog{Streams: make([]ConfiguredStream, 0)}
	for _, s := range streamsArr {
		streamMap, ok := s.(map[string]any)
		if !ok {
			continue
		}
		name := joinStreamName(streamMap)

		// Inclusion check (mirrors the TS filter()).
		_, selected := opts.Streams[name]
		_, disabled := opts.DisabledStreams[name]
		switch {
		case selected:
			// always include explicitly selected
		case opts.SchemaChanges == "streams" && !disabled:
			// auto-include new streams unless explicitly disabled
		default:
			continue
		}

		// User-supplied per-stream config OR derived defaults.
		var streamCfg streamConfigFields
		if raw, ok := opts.Streams[name]; ok {
			_ = json.Unmarshal(raw, &streamCfg)
		} else {
			streamCfg = initStreamDefault(streamMap, hasIncremental)
		}

		// Inject the user's table_name override into the embedded stream
		// payload (mirrors the TS spread `{ ...s, table_name: stream.table_name }`).
		if streamCfg.TableName != "" {
			streamMap["table_name"] = streamCfg.TableName
		}
		streamRaw, err := json.Marshal(streamMap)
		if err != nil {
			return nil, err
		}

		cs := ConfiguredStream{
			Stream:              streamRaw,
			SyncMode:            streamCfg.SyncMode,
			DestinationSyncMode: "overwrite",
			CursorField:         streamCfg.CursorField,
		}
		if cs.SyncMode == "" {
			cs.SyncMode = "full_refresh"
		}
		out.Streams = append(out.Streams, cs)
	}

	// Stable order so identical inputs produce identical files (helps catch
	// no-op runs in argocd/diff tooling).
	sort.SliceStable(out.Streams, func(i, j int) bool {
		var ni, nj map[string]any
		_ = json.Unmarshal(out.Streams[i].Stream, &ni)
		_ = json.Unmarshal(out.Streams[j].Stream, &nj)
		return joinStreamName(ni) < joinStreamName(nj)
	})

	return out, nil
}

// initStreamDefault derives a minimal per-stream config when the user
// selected a stream via "schemaChanges: streams" auto-discovery and didn't
// provide explicit settings. Picks incremental iff the catalog stream
// supports it AND incremental mode is in use elsewhere (the TS heuristic).
func initStreamDefault(streamMap map[string]any, hasIncremental bool) streamConfigFields {
	cfg := streamConfigFields{SyncMode: "full_refresh"}
	supportedRaw, _ := streamMap["supported_sync_modes"].([]any)
	supportsIncremental := false
	for _, m := range supportedRaw {
		if s, ok := m.(string); ok && s == "incremental" {
			supportsIncremental = true
			break
		}
	}
	if supportsIncremental && hasIncremental {
		cfg.SyncMode = "incremental"
		// If the catalog declares default cursor field(s), use them.
		if dcf, ok := streamMap["default_cursor_field"].([]any); ok {
			cfg.CursorField = dcf
		}
	}
	return cfg
}

func joinStreamName(streamMap map[string]any) string {
	name, _ := streamMap["name"].(string)
	if ns, ok := streamMap["namespace"].(string); ok && ns != "" {
		return strings.Join([]string{ns, name}, ".")
	}
	return name
}
