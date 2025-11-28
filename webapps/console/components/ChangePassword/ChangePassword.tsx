import React, { useState } from "react";
import { Button, Input } from "antd";
import { rpc } from "juava";
import { feedbackError, feedbackSuccess } from "../../lib/ui";
import { ButtonLabel } from "../ButtonLabel/ButtonLabel";

export const ChangePassword: React.FC<{
  onSuccess?: () => void | Promise<void>;
  dontAskForCurrentPassword?: boolean;
}> = props => {
  const [loading, setLoading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  let error: string | undefined = undefined;
  if (currentPassword && newPassword && confirmNewPassword) {
    if (newPassword !== confirmNewPassword) {
      error = "New password and confirm password do not match";
    } else if (newPassword.length < 8) {
      error = "Password must be at least 8 characters long";
    }
  }

  return (
    <div className="px-8 py-6 border border-textDisabled rounded-lg space-y-4 mt-6">
      <p className="text-lg font-bold">Change Password</p>
      {!props.dontAskForCurrentPassword && (
        <div className="space-y-2">
          <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700">
            Current password
          </label>
          <Input
            id="currentPassword"
            required
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
          />
        </div>
      )}
      <div className="space-y-2">
        <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700">
          New password
        </label>
        <Input
          id="newPassword"
          required
          type="password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
          Confirm password
        </label>
        <Input
          id="confirmPassword"
          required
          type="password"
          value={confirmNewPassword}
          onChange={e => setConfirmNewPassword(e.target.value)}
        />
      </div>
      <div className={`text-xs text-error my-0 py-0 ${error ? "visible" : "invisible"}`}>{error || "-"}</div>
      <Button
        type="primary"
        disabled={
          !((currentPassword || props.dontAskForCurrentPassword) && newPassword && confirmNewPassword) || !!error
        }
        onClick={async () => {
          if (!loading) {
            try {
              setLoading(true);
              await rpc("/api/user/change-password", { body: { currentPassword, newPassword } });
              if (props.onSuccess) {
                await props.onSuccess();
              } else {
                feedbackSuccess("Password has been changed");
              }
            } catch (e: any) {
              feedbackError(`Failed to change password - ${e.message}`, e);
            } finally {
              setLoading(false);
            }
          }
        }}
      >
        <ButtonLabel loading={loading}>Change Password</ButtonLabel>
      </Button>
    </div>
  );
};
