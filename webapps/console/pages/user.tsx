import { FaArrowLeft } from "react-icons/fa";
import { Button, Form, Input, Modal, Radio, Table, Tag, Tooltip } from "antd";
import { useRouter } from "next/router";
import { useUser } from "../lib/context";
import { get, useApi } from "../lib/useApi";
import React, { useState } from "react";
import { ApiKey, inferTokenTypeFromId } from "../lib/schema";
import { copyTextToClipboard, feedbackError, feedbackSuccess, confirmOp } from "../lib/ui";
import { QueryResponse } from "../components/QueryResponse/QueryResponse";
import { JitsuButton } from "../components/JitsuButton/JitsuButton";
import { ChangePassword } from "../components/ChangePassword/ChangePassword";
import { FaCopy, FaPlus, FaTrash, FaTerminal } from "react-icons/fa";
import { FaCloudArrowUp } from "react-icons/fa6";

const expirationOptions: { label: string; days: number | null }[] = [
  { label: "30 days", days: 30 },
  { label: "60 days", days: 60 },
  { label: "90 days", days: 90 },
  { label: "Never", days: null },
];

function expirationToDate(days: number | null): Date | null {
  if (days === null) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

const dateFmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

function fmtShortDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString(undefined, dateFmt);
}

function fmtFullDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString();
}

function dateValue(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const d = typeof value === "string" ? new Date(value) : value;
  return d.getTime();
}

function effectiveType(key: ApiKey): string {
  if (key.type) return key.type;
  return inferTokenTypeFromId(key.id);
}

const typeStyles: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  cli: { color: "blue", icon: <FaTerminal />, label: "cli" },
  api: { color: "purple", icon: <FaCloudArrowUp />, label: "api" },
};

function TypeTag({ type }: { type: string }) {
  const s = typeStyles[type] ?? { color: "default", icon: null, label: type };
  return (
    <Tag color={s.color} className="inline-flex items-center gap-1">
      {s.icon ? <span className="inline-flex items-center">{s.icon}</span> : null}
      <span>{s.label}</span>
    </Tag>
  );
}

/**
 * Middle-truncate `value` to at most `max` chars, preserving both ends. The
 * full string belongs in a tooltip beside the rendered span. Used for names —
 * common case is a long auto-generated id like `jitsu-cli-Tr78cBn6EHHorI0...`
 * where the prefix is informative but so is the trailing entropy.
 */
function middleTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * `hint` from juava is `XXX*YYY` (3+1+3). Render as `XXX**********YYY` so the
 * masked secret looks like a sk- style preview without being so long it pushes
 * the table out.
 */
function renderSecretHint(hint: string | null | undefined): string {
  if (!hint) return "";
  const parts = hint.split("*");
  if (parts.length !== 2) return hint;
  return `${parts[0]}${"*".repeat(10)}${parts[1]}`;
}

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? "Copied!" : "Copy to clipboard"}>
      <Button
        type="text"
        size="small"
        onClick={() => {
          copyTextToClipboard(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <FaCopy />
      </Button>
    </Tooltip>
  );
};

const NewKeyModal: React.FC<{
  generated: { id: string; plaintext: string } | null;
  onCreate: (vals: { name?: string; expiresAt: Date | null }) => Promise<void>;
  onClose: () => void;
}> = ({ generated, onCreate, onClose }) => {
  const [form] = Form.useForm<{ name?: string; expirationDays: number | null }>();
  const [loading, setLoading] = useState(false);
  const [expirationDays, setExpirationDays] = useState<number | null>(90);

  return (
    <Modal
      open={true}
      title={generated ? "Save your secret key" : "Create new API key"}
      maskClosable={!generated}
      closable={true}
      onCancel={onClose}
      footer={
        generated ? (
          <Button type="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="primary"
              loading={loading}
              onClick={async () => {
                const values = await form.validateFields();
                setLoading(true);
                try {
                  await onCreate({
                    name: values.name?.trim() || undefined,
                    expiresAt: expirationToDate(expirationDays),
                  });
                } finally {
                  setLoading(false);
                }
              }}
            >
              Create key
            </Button>
          </div>
        )
      }
    >
      {generated ? (
        <div className="flex flex-col gap-3">
          <p>
            Copy and store this key in a safe place. <strong>You will not be able to see it again.</strong>
          </p>
          <div className="flex items-center font-mono text-xs bg-neutral-100 rounded px-2 py-1">
            <code className="break-all">
              {generated.id}:{generated.plaintext}
            </code>
            <CopyButton text={`${generated.id}:${generated.plaintext}`} />
          </div>
        </div>
      ) : (
        <Form form={form} layout="vertical" initialValues={{ expirationDays: 90 }}>
          <Form.Item label="Name (optional)" name="name" help="A human-readable label. Leave blank to use the key id.">
            <Input placeholder="e.g. local dev / CI bot" autoFocus />
          </Form.Item>
          <Form.Item label="Expiration" name="expirationDays">
            <Radio.Group
              value={expirationDays}
              onChange={e => setExpirationDays(e.target.value)}
              options={expirationOptions.map(o => ({ label: o.label, value: o.days }))}
              optionType="button"
            />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
};

function ApiKeys() {
  const apiRes = useApi<ApiKey[]>("/api/user/keys");
  const [modalOpen, setModalOpen] = useState(false);
  const [generated, setGenerated] = useState<{ id: string; plaintext: string } | null>(null);

  return (
    <QueryResponse
      result={apiRes}
      errorTitle={"Failed to load API keys"}
      render={keys => {
        const columns: any[] = [
          {
            title: "Name",
            key: "name",
            render: (k: ApiKey) => {
              const full = k.name || k.id;
              const display = middleTruncate(full, 32);
              return (
                <Tooltip title={full}>
                  <span className="font-medium">{display}</span>
                </Tooltip>
              );
            },
          },
          {
            title: "Type",
            key: "type",
            render: (k: ApiKey) => <TypeTag type={effectiveType(k)} />,
          },
          {
            title: "Key ID",
            key: "keyId",
            render: (k: ApiKey) => (
              <Tooltip title={k.id}>
                <code className="font-mono text-xs text-text-light">{middleTruncate(k.id, 22)}</code>
              </Tooltip>
            ),
          },
          {
            title: "Secret key",
            key: "secret",
            render: (k: ApiKey) => (
              <code className="font-mono text-xs text-text-light">{renderSecretHint(k.hint)}</code>
            ),
          },
          {
            title: <span className="whitespace-nowrap">Created</span>,
            dataIndex: "createdAt",
            className: "whitespace-nowrap",
            defaultSortOrder: "descend" as const,
            sorter: (a: ApiKey, b: ApiKey) => dateValue(a.createdAt) - dateValue(b.createdAt),
            render: (v: any) => (
              <Tooltip title={fmtFullDate(v)}>
                <span className="text-sm">{fmtShortDate(v)}</span>
              </Tooltip>
            ),
          },
          {
            title: <span className="whitespace-nowrap">Last used</span>,
            dataIndex: "lastUsed",
            className: "whitespace-nowrap",
            // Sort never-used keys last in descending mode (default 0 → bottom).
            sorter: (a: ApiKey, b: ApiKey) => dateValue(a.lastUsed) - dateValue(b.lastUsed),
            render: (v: any) =>
              v ? (
                <Tooltip title={fmtFullDate(v)}>
                  <span className="text-sm">{fmtShortDate(v)}</span>
                </Tooltip>
              ) : (
                <span className="text-text-light text-sm">Never</span>
              ),
          },
          {
            title: <span className="whitespace-nowrap">Expires</span>,
            dataIndex: "expiresAt",
            className: "whitespace-nowrap",
            sorter: (a: ApiKey, b: ApiKey) => dateValue(a.expiresAt) - dateValue(b.expiresAt),
            render: (v: any) => {
              if (!v) return <span className="text-text-light text-sm">Never</span>;
              const d = new Date(v);
              const expired = d.getTime() < Date.now();
              return (
                <Tooltip title={fmtFullDate(d)}>
                  <span className={`text-sm ${expired ? "text-error" : ""}`}>{fmtShortDate(d)}</span>
                </Tooltip>
              );
            },
          },
          {
            title: "",
            key: "actions",
            className: "text-right",
            width: 48,
            render: (k: ApiKey) => (
              <Button
                type="text"
                size="small"
                onClick={async () => {
                  if (await confirmOp(`Delete key ${k.name || k.id}? This cannot be undone.`)) {
                    try {
                      await get(`/api/user/keys?id=${encodeURIComponent(k.id)}`, { method: "DELETE" });
                      await apiRes.reload();
                      feedbackSuccess("Key deleted");
                    } catch (e) {
                      feedbackError("Failed to delete key");
                    }
                  }
                }}
              >
                <FaTrash />
              </Button>
            ),
          },
        ];

        return (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold m-0">API Keys</h2>
              <Button type="primary" icon={<FaPlus />} onClick={() => setModalOpen(true)}>
                Create the key
              </Button>
            </div>
            <div className="pt-4">
              {keys.length === 0 ? (
                <div className="flex text-textDisabled justify-center py-6">
                  No API keys yet. Click "Create the key" to make one.
                </div>
              ) : (
                <Table size="middle" columns={columns} dataSource={keys} pagination={false} rowKey={k => k.id} />
              )}
            </div>
            {modalOpen && (
              <NewKeyModal
                generated={generated}
                onCreate={async vals => {
                  try {
                    const created = await get("/api/user/keys", {
                      method: "POST",
                      body: { name: vals.name, expiresAt: vals.expiresAt, type: "api" },
                    });
                    setGenerated({ id: created.id, plaintext: created.plaintext });
                    await apiRes.reload();
                    feedbackSuccess("API key created");
                  } catch (e) {
                    feedbackError("Failed to create key");
                  }
                }}
                onClose={() => {
                  setModalOpen(false);
                  setGenerated(null);
                }}
              />
            )}
          </>
        );
      }}
    />
  );
}

const UserPage = (props: any) => {
  const router = useRouter();
  const user = useUser();
  return (
    <div className="flex justify-center">
      <div className="px-4 py-6 flex flex-col items-center w-full" style={{ maxWidth: "1440px", minWidth: "300px" }}>
        <JitsuButton icon={<FaArrowLeft />} size="large" type="primary" onClick={() => router.back()}>
          Go back
        </JitsuButton>
        <div className="w-full grow">
          <h1 className="flex-grow text-3xl py-6">User settings</h1>
          <div className="px-8 py-6 border border-textDisabled rounded-lg">
            <label htmlFor="email" className="text-lg font-bold">
              Email
            </label>
            <div className="mt-3">
              <Input id="email" value={user.email} className="border-error" />

              <p className="text-textDisabled">
                You can't change email, since you logged in with an external user provider - {user.loginProvider}
              </p>
            </div>
          </div>
          {user.loginProvider === "credentials" && <ChangePassword />}
          <div className="px-8 py-6 border border-textDisabled rounded-lg mt-6">
            <ApiKeys />
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserPage;
