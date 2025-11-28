import { useUser } from "../../lib/context";
import React, { useState } from "react";
import { Input } from "antd";
import { get } from "../../lib/useApi";
import { copyTextToClipboard, feedbackError, feedbackSuccess } from "../../lib/ui";
import { JitsuButton } from "../JitsuButton/JitsuButton";
import { pickSlug, pickWorkspaceName } from "../../lib/shared/name-utils";

/**
 * @param onboarding if the dialog is shown on onboarding page. For onboarding,
 * we should issue an event that onboarding is completed
 */
export function WorkspaceNameAndSlugEditor({
  onSuccess,
  displayId,
  onboarding,
  workspace,
  canEdit = true,
}: {
  onSuccess?: (newVals: { name: string; slug: string; id?: string }) => void;
  displayId?: boolean;
  offerClassic?: boolean;
  onboarding?: boolean;
  workspace?: { id?: string; name?: string; slug?: string | null };
  canEdit?: boolean;
}) {
  const user = useUser();
  const [name, setName] = useState(workspace?.name || pickWorkspaceName(user.email, user.name));
  const [slug, setSlug] = useState(workspace?.slug || pickSlug(user.email, workspace?.name || name));
  const [changed, setChanged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [slugError, setSlugError] = useState<string | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  return (
    <div className="bg-backgroundLight border border-textDisabled rounded-lg overflow-hidden">
      <div className="px-6 py-4 bg-background border-b border-textDisabled">
        <h3 className="text-lg font-semibold text-textDark">Workspace Configuration</h3>
      </div>

      <div className="px-6 py-6 space-y-6">
        <div>
          <label className="block text-base font-medium text-textDark mb-2">Workspace Name</label>
          <Input
            disabled={!canEdit}
            value={name}
            size="large"
            onChange={e => {
              setName(e.target.value);
              setChanged(true);
              setNameError(undefined); // Clear error on change
            }}
          />
          {nameError && <div className="text-sm text-error mt-1">{nameError}</div>}
        </div>

        <div>
          <label className="block text-base font-medium text-textDark mb-2">Workspace Slug</label>
          <Input
            disabled={!canEdit}
            value={slug}
            size="large"
            onChange={e => {
              setSlug(e.target.value);
              setChanged(true);
              setSlugError(undefined); // Clear error on change
            }}
          />
          {slugError && <div className="text-sm text-error mt-1">{slugError}</div>}
        </div>

        {displayId && workspace?.id && (
          <div>
            <label className="block text-base font-medium text-textDark mb-2">Workspace ID</label>
            <div
              className="cursor-pointer bg-background text-textDark px-3 py-2 rounded-lg border border-textDisabled font-mono hover:bg-backgroundLight transition-colors"
              onClick={() => {
                copyTextToClipboard(workspace.id!);
                feedbackSuccess("Workspace ID copied to clipboard");
              }}
            >
              {workspace.id}
            </div>
            <p className="text-xs text-text mt-1">
              You'll need this ID for making{" "}
              <a className="underline" href="https://docs.jitsu.com/api">
                API calls
              </a>
            </p>
          </div>
        )}
      </div>

      <div className="px-6 py-4 bg-background border-t border-textDisabled flex justify-end">
        <JitsuButton
          type="primary"
          loading={loading}
          disabled={(workspace?.id && !changed && !onboarding) || !canEdit}
          onClick={async () => {
            setLoading(true);
            try {
              // Validate both name and slug together
              const validation = await get(`/api/workspace/validate`, {
                query: {
                  name,
                  slug,
                  ...(workspace?.id ? { workspaceId: workspace?.id } : {}),
                },
              });

              // Handle validation results
              if (!validation.allValid) {
                if (!validation.name.valid) {
                  setNameError(validation.name.reason);
                }

                if (!validation.slug.valid) {
                  setSlugError(validation.slug.reason);
                  // // Auto-suggest a slug if available
                  // if (validation.slug.suggestedSlug) {
                  //   setSlug(validation.slug.suggestedSlug);
                  // }
                }

                setLoading(false);
                return;
              }

              let workspaceId = workspace?.id;

              // Create new workspace if no ID exists
              if (!workspaceId) {
                const { id } = await get(`/api/workspace${onboarding ? "?onboarding=true" : ""}`, {
                  method: "POST",
                  body: { name, slug },
                });
                workspaceId = id;
                feedbackSuccess("Workspace created successfully");
              } else {
                // Update existing workspace
                await get(`/api/workspace/${workspaceId}?onboarding=${!!onboarding}`, {
                  method: "PUT",
                  body: { name, slug },
                });
                feedbackSuccess("Workspace settings have been saved");
              }

              setChanged(false);
              if (onSuccess) {
                onSuccess({ name, slug, id: workspaceId });
              }
            } catch (e) {
              feedbackError(`Failed to ${workspace?.id ? "save workspace settings" : "create workspace"}`, {
                error: e,
              });
            } finally {
              setLoading(false);
            }
          }}
        >
          {workspace?.id ? "Save Changes" : "Create Workspace"}
        </JitsuButton>
      </div>
    </div>
  );
}
