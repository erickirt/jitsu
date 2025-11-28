import type { ButtonProps } from "antd/es/button/button";
import { Button, Tooltip } from "antd";
import omit from "lodash/omit";

import React from "react";
import { ButtonLabel } from "../ButtonLabel/ButtonLabel";
import { useRouter } from "next/router";
import { useWorkspace, useWorkspaceRole } from "../../lib/context";
import { hasPermission, WorkspacePermissionsType } from "../../lib/workspace-roles";

export type JitsuButtonProps = ButtonProps & {
  //set to true if href is relative workspace link
  ws?: boolean;
  className?: string;
  requiredPermission?: WorkspacePermissionsType;
  //if set, button will be disabled and reason will be displayed as tooltip
  disabledReason?: string;
};

export const WJitsuButton: React.FC<JitsuButtonProps & Required<Pick<ButtonProps, "href">>> = p => {
  const workspace = useWorkspace();
  const router = useRouter();
  return <Button0 {...p} onClick={() => router.push(`/${workspace.slugOrId}${p.href}`)} />;
};

//href button
const HJitsuButton: React.FC<JitsuButtonProps & Required<Pick<ButtonProps, "href">>> = p => {
  const router = useRouter();
  return <Button0 {...p} onClick={() => router.push(p.href)} />;
};

function Button0(props: JitsuButtonProps) {
  const workspaceRole = useWorkspaceRole();
  const hasPerm = props.requiredPermission ? hasPermission(workspaceRole.role, props.requiredPermission) : true;

  // Determine tooltip message
  const tooltipTitle = props.disabledReason
    ? props.disabledReason
    : !hasPerm
    ? `You don't have permission '${props.requiredPermission}'`
    : undefined;

  // Button is disabled if explicitly disabled, no permission, or disabledReason is set
  const isDisabled = props.disabled || !hasPerm || !!props.disabledReason;

  return (
    <Tooltip title={tooltipTitle}>
      <Button
        {...omit(props, "href", "children", "icon", "iconPosition", "disabledReason")}
        disabled={isDisabled}
        className={`pr-1 ${props.className}`}
      >
        {props.icon ? (
          <ButtonLabel icon={props.icon} iconPosition={props.iconPosition} loading={!!props.loading}>
            {props.children}
          </ButtonLabel>
        ) : (
          props.children
        )}
      </Button>
    </Tooltip>
  );
}

export const JitsuButton: React.FC<JitsuButtonProps> = p => {
  if (!p.href) {
    return <Button0 {...p} />;
  }
  if (p.ws) {
    return <WJitsuButton {...omit(p, "ws")} href={p.href} />;
  }
  return <HJitsuButton {...p} href={p.href} />;
};
