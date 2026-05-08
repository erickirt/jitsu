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
import { FaCopy, FaPlus, FaTrash } from "react-icons/fa";

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

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString();
}

function effectiveType(key: ApiKey): string {
  if (key.type) return key.type;
  return inferTokenTypeFromId(key.id);
}

const KeyCell: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center font-mono text-xs">
      <code className="break-all">{value}</code>
      <Tooltip title={copied ? "Copied!" : "Copy to clipboard"}>
        <Button
          type="text"
          size="small"
          onClick={() => {
            copyTextToClipboard(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <FaCopy />
        </Button>
      </Tooltip>
    </div>
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
          <KeyCell value={`${generated.id}:${generated.plaintext}`} />
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
            render: (k: ApiKey) => (
              <div className="flex flex-col">
                <span className="font-medium">{k.name || k.id}</span>
                <Tooltip title={k.id}>
                  <code className="text-xs text-textLight">
                    {k.id}:{k.hint?.replace("*", "*".repeat(32 - 6))}
                  </code>
                </Tooltip>
              </div>
            ),
          },
          {
            title: "Type",
            key: "type",
            render: (k: ApiKey) => <Tag>{effectiveType(k)}</Tag>,
          },
          {
            title: <div className="whitespace-nowrap">Created</div>,
            dataIndex: "createdAt",
            className: "text-xs whitespace-nowrap",
            render: (v: any) => fmtDate(v),
          },
          {
            title: <div className="whitespace-nowrap">Last used</div>,
            dataIndex: "lastUsed",
            className: "text-xs whitespace-nowrap",
            render: (v: any) => (v ? fmtDate(v) : "Never"),
          },
          {
            title: <div className="whitespace-nowrap">Expires</div>,
            dataIndex: "expiresAt",
            className: "text-xs whitespace-nowrap",
            render: (v: any) => {
              if (!v) return <span className="text-textLight">Never</span>;
              const d = new Date(v);
              const expired = d.getTime() < Date.now();
              return <span className={expired ? "text-error" : ""}>{fmtDate(d)}</span>;
            },
          },
          {
            title: "",
            key: "actions",
            className: "text-right",
            render: (k: ApiKey) => (
              <Button
                type="text"
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
              <p className="text-lg font-bold m-0">API Keys</p>
              <Button type="primary" icon={<FaPlus />} onClick={() => setModalOpen(true)}>
                Create the key
              </Button>
            </div>
            <div className="pt-3">
              {keys.length === 0 ? (
                <div className="flex text-textDisabled justify-center py-6">
                  No API keys yet. Click "Create the key" to make one.
                </div>
              ) : (
                <Table size="small" columns={columns} dataSource={keys} pagination={false} rowKey={k => k.id} />
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
      <div className="px-4 py-6 flex flex-col items-center w-full" style={{ maxWidth: "1000px", minWidth: "300px" }}>
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
