// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ModelsPage from "../../pages/[workspaceId]/models";

const getComputedStyle = window.getComputedStyle.bind(window);

const state = vi.hoisted(() => ({
  enabled: true,
  api: { list: vi.fn(), create: vi.fn(), update: vi.fn(), del: vi.fn() },
}));
vi.mock("../../components/PageLayout/WorkspacePageLayout", () => ({
  WorkspacePageLayout: ({ children }: any) => children,
}));
vi.mock("../../lib/context", () => ({
  useWorkspace: () => ({ id: "ws", featuresEnabled: state.enabled ? ["reverse-etl"] : [] }),
  useWorkspaceRole: () => ({ editEntities: true, deleteEntities: true }),
}));
vi.mock("../../lib/useApi", () => ({ useConfigApi: () => state.api }));
vi.mock("../../lib/store", () => ({
  useConfigObjectList: () => [{ id: "wh", name: "Warehouse", destinationType: "postgres" }],
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => getComputedStyle(element));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  state.api.list.mockResolvedValue([
    {
      id: "model-1",
      name: "Audience",
      type: "model",
      workspaceId: "ws",
      warehouseId: "wh",
      query: "SELECT id, changed FROM audience",
      primaryKey: ["id"],
      pageSize: 1000,
      cursor: { column: "changed", type: "timestamp", lookbackSeconds: 60 },
    },
  ]);
  state.api.update.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(ModelsPage)));
  return client;
}

describe("model editor", () => {
  it("preserves an API-configured lookback when changing the name", async () => {
    const client = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Audience" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed audience" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() =>
      expect(state.api.update).toHaveBeenCalledWith(
        "model-1",
        expect.objectContaining({
          name: "Renamed audience",
          cursor: { column: "changed", type: "timestamp", lookbackSeconds: 60 },
        })
      )
    );
    client.clear();
  });
  it("does not fetch Models for a workspace without the flag", async () => {
    state.enabled = false;
    const client = mount();
    expect(screen.getByText("Reverse ETL is not enabled for this workspace")).toBeTruthy();
    expect(state.api.list).not.toHaveBeenCalled();
    client.clear();
  });
});
