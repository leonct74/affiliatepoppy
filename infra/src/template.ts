// AffiliatePoppy's CloudFormation template, authored as typed TypeScript.
//
// WHY NOT CDK (TrafficPoppy's decision, kept): the footprint is one table, two Lambdas with
// Function URLs, their roles and log groups, and one Cognito pool — small enough to author
// directly, which removes cdk from the build AND from the end user's machine. The output is
// the same asset-free template JSON that scripts/build-backend-bundle.mjs embeds into the
// backend bundle.
//
// EVERYTHING LIVES IN THIS ONE STACK (AGENTS.md §4 "the easy path"): deleting the stack
// removes the whole footprint, so teardown can't leak. Nothing gets DeletionPolicy: Retain
// and deletion protection stays off — both would make our own teardown fail. The two
// exceptions, which the teardown hook therefore MUST sweep by hand, are the deploy bucket
// (holds the code zip the stack references) and the SSM parameters holding the merchant's
// Stripe secrets (deliberately outside the stack — see §3.2 of DESIGN.md: a template
// parameter would put a secret in CloudFormation's own history).

/** The one stack we deploy. The manifest's cloudformation grant is scoped to this exact name. */
export const STACK_NAME = "AffiliatePoppyStack";

/**
 * The ledger table. A fixed name (rather than a CloudFormation-generated one) because the
 * merchant's own tooling may read it, and because it matches the manifest's
 * `AffiliatePoppy*` dynamodb scope.
 */
export const TABLE_NAME = "AffiliatePoppyData";

/** The attribute holding a row's expiry — used by the portal's soft rate-limit rows. */
export const TTL_ATTRIBUTE = "expiresAt";

/** Fixed names, all under the `AffiliatePoppy*` prefix the manifest's grants are scoped to. */
export const RECEIVER_FUNCTION_NAME = "AffiliatePoppyReceiver";
export const RECEIVER_ROLE_NAME = "AffiliatePoppyReceiverRole";
export const RECEIVER_HANDLER = "receiver.handler";
export const PORTAL_FUNCTION_NAME = "AffiliatePoppyPortal";
export const PORTAL_ROLE_NAME = "AffiliatePoppyPortalRole";
export const PORTAL_HANDLER = "portal.handler";
export const LAMBDA_RUNTIME = "nodejs20.x";

/** Affiliates sign themselves up here — in the MERCHANT's own account, never ours. */
export const USER_POOL_NAME = "AffiliatePoppyAffiliates";

/**
 * Where the two Stripe secrets live (SecureString). The prefix is what the manifest's ssm
 * grant is scoped to, and what the Lambda execution roles may read.
 */
export const SSM_PREFIX = "/affiliatepoppy";
export const SSM_WEBHOOK_SECRET = `${SSM_PREFIX}/stripe/webhook-secret`;
export const SSM_API_KEY = `${SSM_PREFIX}/stripe/api-key`;
/** P7: the signing secret of a SECOND endpoint, the "connected accounts" one. Optional. */
export const SSM_CONNECT_WEBHOOK_SECRET = `${SSM_PREFIX}/stripe/connect-webhook-secret`;

/**
 * Affiliate passwords are the merchant's partners' passwords — the merchant never sees them
 * and neither do we. Shared with the portal's signup page so the rule an affiliate is TOLD
 * is always the rule Cognito ENFORCES.
 */
export const PASSWORD_POLICY = {
  MinimumLength: 10,
  RequireLowercase: true,
  RequireUppercase: false,
  RequireNumbers: true,
  RequireSymbols: false,
} as const;

export interface CfnTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Parameters?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
  Resources: Record<string, unknown>;
  Outputs: Record<string, unknown>;
}

/**
 * The AgentsPoppy permissions boundary, applied to every IAM role in this stack
 * (broker-role-v2 step 2). The boundary CAPS what a role can ever do — it grants nothing —
 * so the two execution policies below are unaffected either way and no Lambda can lose a
 * permission by gaining it.
 *
 * It is a PARAMETER rather than a hard-coded ARN because naming a policy that isn't in the
 * account yet makes IAM refuse CreateRole outright: the host passes the ARN only once it has
 * confirmed the policy exists, and an empty value (the default) deploys unbounded, which is
 * the correct behaviour for a pre-boundary AgentsPoppy setup.
 */
const BOUNDARY_PARAM = "PermissionsBoundaryArn";
const BOUNDARY_CONDITION = "HasPermissionsBoundary";

/** The `PermissionsBoundary` property every AWS::IAM::Role here carries — set, or absent. */
const permissionsBoundary = {
  "Fn::If": [BOUNDARY_CONDITION, { Ref: BOUNDARY_PARAM }, { Ref: "AWS::NoValue" }],
};

/**
 * Build the template. Pure — same input, same bytes — so the content-addressed hash the
 * build script derives from it is stable across machines.
 *
 * Single-table design (DESIGN.md §3.3), deterministic keys only:
 *   pk = cfg                  sk = portal | stripe
 *   pk = dir                  sk = aff#<affId>
 *   pk = aff#<affId>          sk = profile | led#<stripeId> | tot#<currency>
 *   pk = code#<CODE>          sk = map
 *   pk = sub#<subscriptionId> sk = map
 *   pk = payout#<batchId>     sk = meta
 */
export function buildTemplate(): CfnTemplate {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "AffiliatePoppy — affiliate programs that run entirely in your own AWS.",
    Parameters: {
      // The Lambda code lives in the per-account deploy bucket the backend uploads to before
      // deploying. Passed as parameters so the content-addressed key changes whenever the
      // Lambdas change — CloudFormation then sees a real update instead of NO_CHANGE.
      LambdaCodeBucket: { Type: "String", Description: "S3 bucket holding the Lambda code zip." },
      LambdaCodeKey: { Type: "String", Description: "S3 key of the Lambda code zip (content-addressed)." },
      // Attribution, passed in so the Cognito pool can be BORN tagged. Stack-level tags are
      // normally propagated by CloudFormation, but TrafficPoppy's P5 proved that is NOT
      // universal (CFN's ACM handler called RequestCertificate with no tags at all). A user
      // pool's ARN embeds a random pool id, so its grant CANNOT be name-scoped the way a role
      // is — it must be tag-scoped, which makes being born tagged load-bearing, not cosmetic.
      AttrAccountId: { Type: "String", Description: "agentspoppy:account tag value." },
      AttrConnectionId: { Type: "String", Description: "agentspoppy:connection tag value." },
      [BOUNDARY_PARAM]: {
        Type: "String",
        Default: "",
        Description:
          "ARN of a managed policy to attach as the permissions boundary on every IAM role this stack creates (AgentsPoppy's AgentsPoppyBoundary). Empty = no boundary.",
      },
    },
    Conditions: {
      [BOUNDARY_CONDITION]: { "Fn::Not": [{ "Fn::Equals": [{ Ref: BOUNDARY_PARAM }, ""] }] },
    },
    Resources: {
      LedgerTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: TABLE_NAME,
          // On-demand: nothing provisioned, so an idle program bills ~$0.
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          // CloudFormation enables TTL with a SEPARATE dynamodb:UpdateTimeToLive call after
          // CreateTable (and reads it back with DescribeTimeToLive), so the manifest MUST
          // grant both or the stack creates the table and then rolls back on AccessDenied.
          // This only shows up on a live deploy — keep these two in lockstep with extension.json.
          TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
          // Deliberately absent: DeletionProtectionEnabled — CloudFormation cannot delete a
          // protected table, which would break leaves-no-trace (AGENTS.md §4).
        },
      },

      // ── The money path ────────────────────────────────────────────────────────────────
      // The receiver is the Stripe webhook endpoint. Its role is the tightest in the stack:
      // it reads ONE SSM parameter (the signing secret) and writes only this table.
      ReceiverRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: RECEIVER_ROLE_NAME,
          PermissionsBoundary: permissionsBoundary,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          Policies: [
            {
              PolicyName: "receiver",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
                    Resource: { "Fn::GetAtt": ["LedgerTable", "Arn"] },
                  },
                  {
                    // The signing secret only. NOT the API key: a webhook receiver has no
                    // business creating promotion codes, and an endpoint reachable by the
                    // whole internet is the last place to hold a writable Stripe key.
                    Effect: "Allow",
                    Action: ["ssm:GetParameter"],
                    Resource: [
                      { "Fn::Sub": `arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${SSM_WEBHOOK_SECRET}` },
                      { "Fn::Sub": `arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${SSM_CONNECT_WEBHOOK_SECRET}` },
                    ],
                  },
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    // Build the log-group ARN by name rather than Fn::GetAtt on the LogGroup:
                    // resolving a LogGroup's Arn makes CloudFormation call
                    // logs:DescribeLogGroups, which cannot be scoped to a single group in a
                    // session policy — so the deploy is denied. (TrafficPoppy live lesson.)
                    Resource: {
                      "Fn::Sub": `arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${RECEIVER_FUNCTION_NAME}:*`,
                    },
                  },
                ],
              },
            },
          ],
        },
      },

      // Declared in-stack (rather than left for Lambda to auto-create) so it carries a
      // retention policy AND is removed on teardown — an auto-created group would orphan.
      ReceiverLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: { "Fn::Sub": `/aws/lambda/${RECEIVER_FUNCTION_NAME}` },
          RetentionInDays: 14,
        },
      },

      Receiver: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["ReceiverLogGroup"],
        Properties: {
          FunctionName: RECEIVER_FUNCTION_NAME,
          Runtime: LAMBDA_RUNTIME,
          Handler: RECEIVER_HANDLER,
          Role: { "Fn::GetAtt": ["ReceiverRole", "Arn"] },
          Code: { S3Bucket: { Ref: "LambdaCodeBucket" }, S3Key: { Ref: "LambdaCodeKey" } },
          Timeout: 15,
          MemorySize: 256,
          Environment: {
            Variables: {
              TABLE_NAME: { Ref: "LedgerTable" },
              WEBHOOK_SECRET_PARAM: SSM_WEBHOOK_SECRET,
              CONNECT_WEBHOOK_SECRET_PARAM: SSM_CONNECT_WEBHOOK_SECRET,
            },
          },
        },
      },

      // AuthType NONE because the caller is Stripe, which authenticates itself with a signed
      // header instead of SigV4. Every request is rejected unless its Stripe-Signature
      // verifies against the merchant's own signing secret — that check IS the auth.
      ReceiverUrl: {
        Type: "AWS::Lambda::Url",
        Properties: {
          TargetFunctionArn: { "Fn::GetAtt": ["Receiver", "Arn"] },
          AuthType: "NONE",
        },
      },
      // A public Function URL needs TWO resource-based permission statements since the
      // October 2025 Lambda change (docs: urls-auth): InvokeFunctionUrl (gated to auth-type
      // NONE) AND InvokeFunction (gated to calls made via the URL). The console writes both
      // automatically; CloudFormation users must declare both. With only the first, every
      // anonymous request gets 403 "even if the function URL uses the NONE auth type" —
      // which cost TrafficPoppy a full day of live debugging.
      ReceiverUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Receiver" },
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        },
      },
      ReceiverUrlInvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Receiver" },
          Action: "lambda:InvokeFunction",
          Principal: "*",
          InvokedViaFunctionUrl: true,
        },
      },

      // ── The affiliate portal ──────────────────────────────────────────────────────────
      // Affiliate accounts live in the MERCHANT's own Cognito pool: no partner's email or
      // password ever reaches us, which keeps "nothing reaches us" literally true.
      AffiliatePool: {
        Type: "AWS::Cognito::UserPool",
        Properties: {
          UserPoolName: USER_POOL_NAME,
          // Self-signup is the whole point of D10: the merchant shares one link and never
          // builds a protected page. Abuse is bounded by the portal's own enrollment cap and
          // rate limit, plus the merchant's approval toggle (D8).
          AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
          UsernameAttributes: ["email"],
          AutoVerifiedAttributes: ["email"],
          // Cognito's built-in sender: no SES identity to verify, no domain to prove, nothing
          // for the merchant to set up before their first affiliate can enroll. Its ~50
          // mails/day ceiling is ample for enrollment; the Settings tab explains the upgrade.
          EmailConfiguration: { EmailSendingAccount: "COGNITO_DEFAULT" },
          // EMAIL_ONLY recovery: no SMS, so no SNS role, no spend, no phone number collected.
          AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] },
          Policies: { PasswordPolicy: { ...PASSWORD_POLICY } },
          // Born tagged — see the Parameters note. Values match stackTags() exactly so the
          // explicit tags and CloudFormation's propagated stack tags can never disagree.
          UserPoolTags: {
            "agentspoppy:account": { Ref: "AttrAccountId" },
            "agentspoppy:app": "com.affiliatepoppy.desktop",
            "agentspoppy:connection": { Ref: "AttrConnectionId" },
            "agentspoppy:managed": "affiliatepoppy",
          },
        },
      },

      // A PUBLIC client (no secret): the portal page runs in the affiliate's browser, where a
      // secret could not be kept anyway. USER_PASSWORD_AUTH rather than SRP for the same
      // reason TrafficPoppy chose it — the page is dependency-free vanilla JS, and a
      // hand-rolled SRP implementation is exactly the crypto that is easy to get subtly wrong.
      AffiliatePoolClient: {
        Type: "AWS::Cognito::UserPoolClient",
        Properties: {
          ClientName: "AffiliatePoppyPortalClient",
          UserPoolId: { Ref: "AffiliatePool" },
          GenerateSecret: false,
          ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
          // Short access tokens (a removed affiliate loses access within the hour) with a long
          // refresh token, so an affiliate in good standing is never asked to sign in again.
          AccessTokenValidity: 60,
          IdTokenValidity: 60,
          RefreshTokenValidity: 3650,
          TokenValidityUnits: { AccessToken: "minutes", IdToken: "minutes", RefreshToken: "days" },
          PreventUserExistenceErrors: "ENABLED",
        },
      },

      PortalRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: PORTAL_ROLE_NAME,
          PermissionsBoundary: permissionsBoundary,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          Policies: [
            {
              PolicyName: "portal",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
                    Resource: { "Fn::GetAtt": ["LedgerTable", "Arn"] },
                  },
                  {
                    // The restricted promotion-codes key — this is the one place it is read,
                    // and only to issue an enrolling affiliate their code.
                    Effect: "Allow",
                    Action: ["ssm:GetParameter"],
                    Resource: {
                      "Fn::Sub": `arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${SSM_API_KEY}`,
                    },
                  },
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    Resource: {
                      "Fn::Sub": `arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${PORTAL_FUNCTION_NAME}:*`,
                    },
                  },
                ],
              },
            },
          ],
        },
      },

      PortalLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: { "Fn::Sub": `/aws/lambda/${PORTAL_FUNCTION_NAME}` },
          RetentionInDays: 14,
        },
      },

      Portal: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["PortalLogGroup"],
        Properties: {
          FunctionName: PORTAL_FUNCTION_NAME,
          Runtime: LAMBDA_RUNTIME,
          Handler: PORTAL_HANDLER,
          Role: { "Fn::GetAtt": ["PortalRole", "Arn"] },
          // The same content-addressed zip as the receiver — one artifact, two handlers, so
          // there is only one key to upload, compare and reason about.
          Code: { S3Bucket: { Ref: "LambdaCodeBucket" }, S3Key: { Ref: "LambdaCodeKey" } },
          Timeout: 15,
          MemorySize: 256,
          Environment: {
            Variables: {
              TABLE_NAME: { Ref: "LedgerTable" },
              USER_POOL_ID: { Ref: "AffiliatePool" },
              USER_POOL_CLIENT_ID: { Ref: "AffiliatePoolClient" },
              API_KEY_PARAM: SSM_API_KEY,
            },
          },
        },
      },

      // AuthType NONE because authentication happens in the application layer (a verified
      // Cognito JWT): the signup page itself must be reachable by a signed-out browser.
      // Every /api route rejects a missing or invalid token.
      PortalUrl: {
        Type: "AWS::Lambda::Url",
        Properties: {
          TargetFunctionArn: { "Fn::GetAtt": ["Portal", "Arn"] },
          AuthType: "NONE",
          Cors: {
            AllowOrigins: ["*"],
            AllowMethods: ["GET", "POST"],
            AllowHeaders: ["content-type", "authorization"],
            MaxAge: 86400,
          },
        },
      },
      PortalUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Portal" },
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        },
      },
      PortalUrlInvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Portal" },
          Action: "lambda:InvokeFunction",
          Principal: "*",
          InvokedViaFunctionUrl: true,
        },
      },
    },
    Outputs: {
      TableName: {
        Description: "The DynamoDB table holding this program's affiliates and ledger.",
        Value: { Ref: "LedgerTable" },
      },
      TableArn: {
        Description: "ARN of the ledger table — for the merchant's own tooling.",
        Value: { "Fn::GetAtt": ["LedgerTable", "Arn"] },
      },
      ReceiverUrl: {
        Description: "The webhook endpoint to add in Stripe (it listens for completed checkouts).",
        Value: { "Fn::GetAtt": ["ReceiverUrl", "FunctionUrl"] },
      },
      PortalUrl: {
        Description: "The affiliate portal — the link the merchant shares with people who want to join.",
        Value: { "Fn::GetAtt": ["PortalUrl", "FunctionUrl"] },
      },
      AffiliatePoolId: {
        Description: "Cognito pool holding this program's affiliate accounts (merchant's own account).",
        Value: { Ref: "AffiliatePool" },
      },
      AffiliatePoolClientId: {
        Description: "Public client id the portal page signs in against.",
        Value: { Ref: "AffiliatePoolClient" },
      },
    },
  };
}
