import React, { useEffect, useState } from "react";
import { Users, MessageSquare, Vote, TrendingUp, Clock, DollarSign, MapPin, BarChart3 } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useTheme } from "../context/ThemeContext";

interface AnalyticsDashboardProps {
  meetingId: string;
  apiBase: string;
}

type VotingRule = "majority" | "unanimous" | "most_pleasure" | "least_misery" | "single_decider";

interface AnalyticsData {
  discussion_dynamics: {
    activity: {
      total_tokens: number;
      total_processing_time: number;
      total_turns: number;
      tokens_per_agent: Record<string, number>;
      token_usage_per_agent: Record<string, { input: number; output: number; total: number }>;
      processing_time_per_agent: Record<string, number>;
      turns_per_agent: Record<string, number>;
      llm_calls: Array<{
        turn: number;
        speaker: string;
        step: number;
        call_type: string;
        prompt_tokens: number;
        completion_tokens?: number;
        retries?: number;
      }>;
    };
    proposals: {
      total_modifications: number;
      overall_acceptance_rate: number;
      modifications_per_agent: Record<string, number>;
      accepted_modifications_per_agent: Record<string, number>;
      acceptance_rate_per_agent: Record<string, number>;
    };
    consensus: {
      approval: {
        total_votes: number;
        votes_per_agent: Record<string, number>;
        total_approval_votes?: number;
        total_reject_votes?: number;
        approval_votes_per_agent?: Record<string, number>;
        reject_votes_per_agent?: Record<string, number>;
        received_approval_votes_per_agent?: Record<string, number>;
        received_reject_votes_per_agent?: Record<string, number>;
      };
      scoring: {
        total_votes: number;
        score_stats: {
          mean: number;
          min: number;
          max: number;
          std: number;
        };
        score_stats_per_agent: Record<string, {
          mean: number;
          min: number;
          max: number;
          std: number;
          count: number;
        }>;
        received_score_stats_per_agent: Record<string, {
          mean: number;
          min: number;
          max: number;
          std: number;
          count: number;
        }>;
        all_scores: number[];
        scores_by_agent: Record<string, number[]>;
        received_scores_by_agent: Record<string, number[]>;
      };
    };
  };
  route_characteristics: {
    travel_time_transition: Array<[number, number]>;
    cost_transition: Record<string, Array<[number, number]>>;
    destination_count_transition: Array<[number, number]>;
    destination_coverage: number;
    total_proposed_destinations: number;
    final_destinations_count: number;
  };
  meeting_duration: number | null;
}

/** Read a CSS custom property from :root as a resolved color string */
function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default function AnalyticsDashboard({ meetingId, apiBase }: AnalyticsDashboardProps) {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [scoreViewMode, setScoreViewMode] = useState<"given" | "received">("given");
  const [voteViewMode, setVoteViewMode] = useState<"given" | "received">("given");
  const [tokenMode, setTokenMode] = useState<"prompt" | "completion">("prompt");
  const [votingRule, setVotingRule] = useState<VotingRule | null>(null);
  const { theme } = useTheme();

  // Resolve CSS variables for Recharts (which needs actual color strings)
  const accentColor = getCSSVar("--accent");
  const surfaceColor = getCSSVar("--surface");
  const outlineColor = getCSSVar("--outline");
  const textTertiary = getCSSVar("--on-surface-tertiary");

  const hasAnalyticsContent = (data: AnalyticsData | null) => {
    if (!data) return false;
    return (
      data.discussion_dynamics.activity.total_turns > 0 ||
      data.discussion_dynamics.activity.llm_calls.length > 0 ||
      (data.route_characteristics.travel_time_transition?.length ?? 0) > 0
    );
  };

  useEffect(() => {
    const storageKey = `analytics-dashboard:${meetingId}`;

    const normalizeAnalyticsData = (rawData: any): AnalyticsData => {
      const approvalVotes = rawData.discussion_dynamics?.consensus?.approval?.total_votes ?? 0;
      const explicitApprovalVotes = rawData.discussion_dynamics?.consensus?.approval?.total_approval_votes;
      const explicitRejectVotes = rawData.discussion_dynamics?.consensus?.approval?.total_reject_votes;
      const approvalVotesPerAgent =
        rawData.discussion_dynamics?.consensus?.approval?.approval_votes_per_agent ??
        rawData.discussion_dynamics?.consensus?.approval?.votes_per_agent ??
        {};
      const rejectVotesPerAgent =
        rawData.discussion_dynamics?.consensus?.approval?.reject_votes_per_agent ?? {};
      const receivedApprovalVotesPerAgent =
        rawData.discussion_dynamics?.consensus?.approval?.received_approval_votes_per_agent ?? {};
      const receivedRejectVotesPerAgent =
        rawData.discussion_dynamics?.consensus?.approval?.received_reject_votes_per_agent ?? {};
      const fallbackApprovalVotes = Object.values(approvalVotesPerAgent as Record<string, number>)
        .reduce((sum: number, v: number) => sum + (Number(v) || 0), 0);
      const fallbackRejectVotes = Object.values(rejectVotesPerAgent as Record<string, number>)
        .reduce((sum: number, v: number) => sum + (Number(v) || 0), 0);
      const totalApprovalVotes = explicitApprovalVotes ?? fallbackApprovalVotes ?? approvalVotes;
      const totalRejectVotes = explicitRejectVotes ?? fallbackRejectVotes ?? 0;
      const totalBinaryVotes = Math.max(approvalVotes, totalApprovalVotes + totalRejectVotes);
      const scoringVotes = rawData.discussion_dynamics?.consensus?.scoring?.total_votes ?? 0;

      // cost_transition changed from a flat series to one series per
      // currency; convert legacy payloads (e.g. cached in localStorage)
      // to the new shape under the '' (unknown currency) key.
      const rawCost = rawData.route_characteristics?.cost_transition;
      const costTransition: Record<string, Array<[number, number]>> = Array.isArray(rawCost)
        ? rawCost.length > 0
          ? { "": rawCost }
          : {}
        : rawCost ?? {};

      return {
        ...rawData,
        route_characteristics: {
          ...rawData.route_characteristics,
          cost_transition: costTransition,
        },
        discussion_dynamics: {
          ...rawData.discussion_dynamics,
          activity: {
            ...rawData.discussion_dynamics?.activity,
            llm_calls: rawData.discussion_dynamics?.activity?.llm_calls ?? [],
          },
          consensus: {
            approval: {
              total_votes: totalBinaryVotes,
              total_approval_votes: totalApprovalVotes,
              total_reject_votes: totalRejectVotes,
              votes_per_agent: approvalVotesPerAgent,
              approval_votes_per_agent: approvalVotesPerAgent,
              reject_votes_per_agent: rejectVotesPerAgent,
              received_approval_votes_per_agent: receivedApprovalVotesPerAgent,
              received_reject_votes_per_agent: receivedRejectVotesPerAgent,
            },
            scoring: {
              total_votes: scoringVotes,
              score_stats: rawData.discussion_dynamics?.consensus?.scoring?.score_stats ?? {
                mean: 0,
                min: 0,
                max: 0,
                std: 0,
              },
              score_stats_per_agent: rawData.discussion_dynamics?.consensus?.scoring?.score_stats_per_agent ?? {},
              received_score_stats_per_agent: rawData.discussion_dynamics?.consensus?.scoring?.received_score_stats_per_agent ?? {},
              all_scores: rawData.discussion_dynamics?.consensus?.scoring?.all_scores ?? [],
              scores_by_agent: rawData.discussion_dynamics?.consensus?.scoring?.scores_by_agent ?? {},
              received_scores_by_agent: rawData.discussion_dynamics?.consensus?.scoring?.received_scores_by_agent ?? {},
            },
          },
        },
      };
    };

    const getCachedAnalytics = (): AnalyticsData | null => {
      if (typeof window === "undefined" || !window?.localStorage) {
        return null;
      }
      try {
        const cached = window.localStorage.getItem(storageKey);
        if (!cached) return null;
        const rawData = JSON.parse(cached);
        return normalizeAnalyticsData(rawData);
      } catch (err) {
        console.error("Failed to read cached analytics:", err);
        return null;
      }
    };

    const cacheAnalytics = (data: AnalyticsData) => {
      if (typeof window === "undefined" || !window?.localStorage) {
        return;
      }
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(data));
      } catch (err) {
        console.error("Failed to cache analytics:", err);
      }
    };

    const cachedAnalytics = getCachedAnalytics();
    if (cachedAnalytics) {
      setAnalytics(cachedAnalytics);
      setLoading(false);
    } else {
      setLoading(true);
    }

    const fetchAnalytics = async (isInitialLoad: boolean = false) => {
      try {
        if (isInitialLoad) {
          setLoading(true);
          setError(null);
        }

        const response = await fetch(`${apiBase}/meetings/${meetingId}/analytics/summary`);

        if (!response.ok) {
          throw new Error(`Failed to fetch analytics: ${response.statusText}`);
        }

        const rawData = await response.json();

        // Normalize the data structure to ensure consensus fields exist
        const data = normalizeAnalyticsData(rawData);

        // Only update state if data has actually changed
        setAnalytics((prevAnalytics: AnalyticsData | null) => {
          if (JSON.stringify(prevAnalytics) === JSON.stringify(data)) {
            return prevAnalytics;
          }

          const nextHasData = hasAnalyticsContent(data);
          const prevHasData = hasAnalyticsContent(prevAnalytics);

          if (!nextHasData && prevHasData) {
            return prevAnalytics;
          }

          if (nextHasData) {
            cacheAnalytics(data);
          }

          return data;
        });

        // Clear error on successful fetch
        if (error) {
          setError(null);
        }
      } catch (err) {
        console.error("Failed to fetch analytics:", err);
        // Only set error on initial load, otherwise keep showing old data
        if (isInitialLoad) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (isInitialLoad) {
          setLoading(false);
        }
      }
    };

    // Initial fetch: skip spinner if cached data already loaded
    fetchAnalytics(!Boolean(cachedAnalytics));

    // Set up polling every 5 seconds
    const intervalId = setInterval(() => {
      fetchAnalytics(false);
    }, 5000);

    // Cleanup interval on unmount
    return () => {
      clearInterval(intervalId);
    };
  }, [meetingId, apiBase]);

  useEffect(() => {
    let cancelled = false;
    const fetchVotingRule = async () => {
      try {
        const response = await fetch(`${apiBase}/meetings/${meetingId}`);
        if (!response.ok) return;
        const data = await response.json();
        const rule = data?.initialization_voting_rule;
        const validRules: VotingRule[] = ["majority", "unanimous", "most_pleasure", "least_misery", "single_decider"];
        if (!cancelled && validRules.includes(rule)) {
          setVotingRule(rule);
        }
      } catch {
        // Keep fallback behavior if rule fetch fails.
      }
    };
    fetchVotingRule();
    return () => {
      cancelled = true;
    };
  }, [meetingId, apiBase]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto mb-4"></div>
          <p className="text-on-surface-tertiary">Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <p className="text-red-600 mb-2">Failed to load analytics</p>
          <p className="text-on-surface-tertiary text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-on-surface-tertiary">No analytics data available</p>
      </div>
    );
  }

  const { discussion_dynamics, route_characteristics, meeting_duration } = analytics;
  const hasData = hasAnalyticsContent(analytics);
  const voteRules: VotingRule[] = ["majority", "unanimous", "single_decider"];
  const approvalVotesCount = discussion_dynamics.consensus?.approval?.total_votes ?? 0;
  const scoreVotesCount = discussion_dynamics.consensus?.scoring?.total_votes ?? 0;
  const showVoteMetric = votingRule
    ? voteRules.includes(votingRule)
    : approvalVotesCount >= scoreVotesCount;
  const showScoreMetric = !showVoteMetric;
  const topMetricsGridCols = showVoteMetric || showScoreMetric
    ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
    : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3";

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Users className="w-16 h-16 text-on-surface-tertiary mx-auto mb-4" />
          <p className="text-on-surface-secondary text-lg mb-2">No meeting data yet</p>
          <p className="text-on-surface-tertiary text-sm">Start a meeting to see analytics</p>
        </div>
      </div>
    );
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  const formatLargeNumber = (num: number) => {
    const rounded = Math.round(num);
    if (rounded < 1000) {
      return rounded.toString();
    } else if (rounded < 10000) {
      return (rounded / 1000).toFixed(1) + 'K';
    } else if (rounded < 1000000) {
      return Math.round(rounded / 1000) + 'K';
    } else {
      return (rounded / 1000000).toFixed(1) + 'M';
    }
  };

  const SimpleLineChart = ({
    data,
    valueFormatter,
  }: {
    data: Array<[number, number]>;
    valueFormatter: (val: number) => string;
  }) => {
    if (data.length === 0) return null;

    // Convert data to recharts format
    const chartData = data.map(([turn, value], idx) => ({
      name: `Route ${idx + 1}`,
      value: value,
    }));

    return (
      <div className="w-full bg-surface-secondary rounded-lg p-4" style={{ height: '280px' }}>
        <div className="w-full h-full flex items-center justify-center">
          <ResponsiveContainer width="95%" height="95%">
            <LineChart
              data={chartData}
              margin={{ top: 15, right: 20, left: 0, bottom: 15 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={outlineColor} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: textTertiary }}
                stroke={textTertiary}
              />
              <YAxis
                tickFormatter={(value) => valueFormatter(value)}
                tick={{ fontSize: 12, fill: textTertiary }}
                stroke={textTertiary}
                width={50}
              />
              <Tooltip
                formatter={(value: number) => [valueFormatter(value), 'Value']}
                contentStyle={{
                  backgroundColor: surfaceColor,
                  border: `1px solid ${outlineColor}`,
                  borderRadius: '0.5rem',
                  padding: '8px 12px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                }}
                labelStyle={{ fontWeight: 600, marginBottom: '4px' }}
              />
              <Line
                type="linear"
                dataKey="value"
                stroke={accentColor}
                strokeWidth={3}
                dot={{ fill: accentColor, strokeWidth: 2, r: 5, stroke: surfaceColor }}
                activeDot={{ r: 7, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  const MetricCard = ({ icon: Icon, label, value, subtitle }: any) => (
    <div className="bg-surface rounded-lg border border-outline p-4 hover:border-accent transition-colors">
      <div className="flex items-start justify-between mb-2">
        <Icon className="w-5 h-5 text-accent" />
      </div>
      <div className="text-2xl font-bold text-on-surface mb-1">{value}</div>
      <div className="text-sm text-on-surface-tertiary mb-1">{label}</div>
      {subtitle && <div className="text-xs text-on-surface-tertiary">{subtitle}</div>}
    </div>
  );

  const agentNames = Object.keys(discussion_dynamics.activity.turns_per_agent);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto w-full px-6 py-8">
        {/* Overview Metrics */}
        <div className={`${topMetricsGridCols} gap-4 mb-8`}>
          <MetricCard
            icon={Clock}
            label="Meeting Duration"
            value={formatDuration(meeting_duration)}
          />
          <MetricCard
            icon={MessageSquare}
            label="Total Turns"
            value={discussion_dynamics.activity.total_turns}
          />
          <MetricCard
            icon={TrendingUp}
            label="Total Proposals"
            value={discussion_dynamics.proposals.total_modifications}
            subtitle={`${(discussion_dynamics.proposals.overall_acceptance_rate * 100).toFixed(0)}% accepted`}
          />
          {showVoteMetric && (
            <MetricCard
              icon={Vote}
              label="Total Votes"
              value={approvalVotesCount}
            />
          )}
          {showScoreMetric && (
            <MetricCard
              icon={BarChart3}
              label="Avg Score"
              value={(() => {
                const scoringStats = discussion_dynamics.consensus?.scoring?.score_stats;
                const totalVotes = discussion_dynamics.consensus?.scoring?.total_votes ?? 0;
                if (!scoringStats || totalVotes === 0) return "0";
                return scoringStats.mean.toFixed(1);
              })()}
              subtitle={(() => {
                const totalVotes = discussion_dynamics.consensus?.scoring?.total_votes ?? 0;
                return totalVotes > 0 ? `${totalVotes} scores` : undefined;
              })()}
            />
          )}
        </div>

        {/* Activity Section */}
        <div className="bg-surface rounded-lg border border-outline p-6 mb-8">
          <h2 className="text-xl font-bold text-on-surface mb-6 flex items-center gap-2">
            <Users className="w-5 h-5 text-accent" />
            Agent Activity
          </h2>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Turns */}
            <div className="bg-surface-secondary rounded-lg p-4 border border-outline">
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-4">Turns</h3>
              <div className="space-y-3">
                {agentNames.map((agentName) => {
                  const turns = discussion_dynamics.activity.turns_per_agent[agentName] || 0;
                  const maxTurns = Math.max(...Object.values(discussion_dynamics.activity.turns_per_agent));
                  const turnPercent = maxTurns > 0 ? (turns / maxTurns) * 100 : 0;

                  return (
                    <div key={agentName} className="border-b border-outline last:border-0 pb-3 last:pb-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium text-on-surface text-sm">{agentName}</div>
                        <div className="text-sm font-semibold text-accent">{turns}</div>
                      </div>
                      <div className="w-full bg-surface-tertiary rounded-full h-2">
                        <div
                          className="bg-accent h-2 rounded-full transition-all"
                          style={{ width: `${turnPercent}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tokens */}
            <div className="bg-surface-secondary rounded-lg p-4 border border-outline">
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-4">Tokens</h3>
              <div className="space-y-3">
                {agentNames.map((agentName) => {
                  const tokenUsage = discussion_dynamics.activity.token_usage_per_agent?.[agentName] || { input: 0, output: 0, total: 0 };
                  const allTokenUsages = Object.values(discussion_dynamics.activity.token_usage_per_agent || {}) as Array<{ input: number; output: number; total: number }>;
                  const maxTokens = allTokenUsages.length > 0 ? Math.max(...allTokenUsages.map(u => u.total)) : 0;
                  const tokenPercent = maxTokens > 0 ? (tokenUsage.total / maxTokens) * 100 : 0;

                  return (
                    <div key={agentName} className="border-b border-outline last:border-0 pb-3 last:pb-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium text-on-surface text-sm">{agentName}</div>
                        <div className="text-xs text-on-surface-tertiary">
                          <span className="font-medium">Total:</span> {formatLargeNumber(tokenUsage.total)}
                          {" | "}
                          <span className="font-medium">Input:</span> {formatLargeNumber(tokenUsage.input)}
                          {" | "}
                          <span className="font-medium">Output:</span> {formatLargeNumber(tokenUsage.output)}
                        </div>
                      </div>
                      <div className="w-full bg-surface-tertiary rounded-full h-2">
                        <div
                          className="bg-accent h-2 rounded-full transition-all"
                          style={{ width: `${tokenPercent}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Processing Time */}
            <div className="bg-surface-secondary rounded-lg p-4 border border-outline">
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-4">Processing Time</h3>
              <div className="space-y-3">
                {agentNames.map((agentName) => {
                  const time = discussion_dynamics.activity.processing_time_per_agent[agentName] || 0;
                  const maxTime = Math.max(...Object.values(discussion_dynamics.activity.processing_time_per_agent));
                  const timePercent = maxTime > 0 ? (time / maxTime) * 100 : 0;

                  return (
                    <div key={agentName} className="border-b border-outline last:border-0 pb-3 last:pb-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium text-on-surface text-sm">{agentName}</div>
                        <div className="text-sm font-semibold text-accent">{time.toFixed(1)}s</div>
                      </div>
                      <div className="w-full bg-surface-tertiary rounded-full h-2">
                        <div
                          className="bg-accent h-2 rounded-full transition-all"
                          style={{ width: `${timePercent}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Token Usage per LLM Call */}
        {discussion_dynamics.activity.llm_calls.length > 0 && (() => {
          const calls = discussion_dynamics.activity.llm_calls;
          const speakers = [...new Set(calls.map((c) => c.speaker))];
          const tokenField = tokenMode === "prompt" ? "prompt_tokens" : "completion_tokens";
          const chartData = calls.map((call, idx) => {
            const point: Record<string, any> = {
              index: idx + 1,
              label: `T${call.turn} S${call.step}`,
              turn: call.turn,
              step: call.step,
              call_type: call.call_type,
              speaker: call.speaker,
              retries: call.retries ?? 0,
              prompt_tokens: call.prompt_tokens,
              completion_tokens: call.completion_tokens ?? 0,
            };
            point[call.speaker] = (call as any)[tokenField] ?? 0;
            return point;
          });

          return (
            <div className="bg-surface rounded-lg border border-outline p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-on-surface flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-accent" />
                  Token Usage per LLM Call
                </h2>
                <div className="flex items-center gap-1 bg-surface-secondary rounded-lg p-0.5">
                  <button
                    onClick={() => setTokenMode("prompt")}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                      tokenMode === "prompt"
                        ? "bg-accent text-white"
                        : "text-on-surface-tertiary hover:text-on-surface"
                    }`}
                  >
                    Input
                  </button>
                  <button
                    onClick={() => setTokenMode("completion")}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                      tokenMode === "completion"
                        ? "bg-accent text-white"
                        : "text-on-surface-tertiary hover:text-on-surface"
                    }`}
                  >
                    Output
                  </button>
                </div>
              </div>
              <p className="text-sm text-on-surface-tertiary mb-4">
                {tokenMode === "prompt"
                  ? "Prompt (input) token count per LLM call, showing how the context window grows over the meeting."
                  : "Completion (output) token count per LLM call."}
                <span className="inline-block ml-2" style={{ color: "#ef4444" }}>&#9675;</span>
                <span className="ml-1">= retried call</span>
              </p>
              <div className="w-full bg-surface-secondary rounded-lg p-4" style={{ height: "320px" }}>
                <div className="w-full h-full flex items-center justify-center">
                  <ResponsiveContainer width="95%" height="95%">
                    <LineChart
                      data={chartData}
                      margin={{ top: 15, right: 20, left: 10, bottom: 15 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={outlineColor} />
                      <XAxis
                        dataKey="index"
                        tick={{ fontSize: 11, fill: textTertiary }}
                        stroke={textTertiary}
                        label={{ value: "LLM Call #", position: "insideBottom", offset: -10, fontSize: 12, fill: textTertiary }}
                      />
                      <YAxis
                        tickFormatter={(value: number) => formatLargeNumber(value)}
                        tick={{ fontSize: 12, fill: textTertiary }}
                        stroke={textTertiary}
                        width={55}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0]?.payload;
                          if (!d) return null;
                          const tokens = payload[0]?.value as number;
                          return (
                            <div
                              style={{
                                backgroundColor: surfaceColor,
                                border: `1px solid ${outlineColor}`,
                                borderRadius: "0.5rem",
                                padding: "8px 12px",
                                boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                              }}
                            >
                              <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.speaker}</div>
                              <div style={{ fontSize: 12 }}>
                                Turn {d.turn} · Step {d.step} · {d.call_type}
                              </div>
                              {d.retries > 0 && (
                                <div style={{ fontSize: 12, color: "#ef4444", marginTop: 2 }}>
                                  {d.retries} {d.retries === 1 ? "retry" : "retries"}
                                </div>
                              )}
                              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                                {formatLargeNumber(tokens)} {tokenMode === "prompt" ? "input" : "output"} tokens
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Legend wrapperStyle={{ paddingTop: "10px" }} iconType="circle" />
                      {speakers.map((speaker, idx) => {
                        const color = `hsl(${(idx * 360) / speakers.length}, 70%, 50%)`;
                        return (
                          <Line
                            key={speaker}
                            type="linear"
                            dataKey={speaker}
                            stroke={color}
                            strokeWidth={2}
                            dot={(props: any) => {
                              const { cx, cy, payload } = props;
                              if (cx == null || cy == null) return <g />;
                              const hasRetries = payload?.retries > 0 && payload?.speaker === speaker;
                              if (hasRetries) {
                                return (
                                  <g>
                                    <circle cx={cx} cy={cy} r={6} fill="none" stroke="#ef4444" strokeWidth={2} />
                                    <circle cx={cx} cy={cy} r={3} fill={color} stroke={color} />
                                  </g>
                                );
                              }
                              return <circle cx={cx} cy={cy} r={3} fill={color} stroke={color} />;
                            }}
                            connectNulls
                            isAnimationActive={false}
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Proposals Section */}
        <div className="bg-surface rounded-lg border border-outline p-6 mb-8">
          <h2 className="text-xl font-bold text-on-surface mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-accent" />
            Proposal Dynamics
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="text-center p-4 bg-surface-secondary rounded-lg">
              <div className="text-3xl font-bold text-accent mb-1">
                {discussion_dynamics.proposals.total_modifications}
              </div>
              <div className="text-sm text-on-surface-tertiary">Total Proposals</div>
            </div>
            <div className="text-center p-4 bg-surface-secondary rounded-lg">
              <div className="text-3xl font-bold text-accent mb-1">
                {(discussion_dynamics.proposals.overall_acceptance_rate * 100).toFixed(0)}%
              </div>
              <div className="text-sm text-on-surface-tertiary">Acceptance Rate</div>
            </div>
          </div>
          <div className="space-y-3">
            {agentNames.map((agentName) => {
              const proposed = discussion_dynamics.proposals.modifications_per_agent[agentName] || 0;
              const accepted = discussion_dynamics.proposals.accepted_modifications_per_agent[agentName] || 0;
              const rate = discussion_dynamics.proposals.acceptance_rate_per_agent[agentName] || 0;

              if (proposed === 0) return null;

              return (
                <div key={agentName} className="flex items-center justify-between p-3 bg-surface-secondary rounded-lg">
                  <div className="font-medium text-on-surface">{agentName}</div>
                  <div className="text-sm text-on-surface-tertiary">
                    {accepted}/{proposed} accepted ({(rate * 100).toFixed(0)}%)
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Route Characteristics */}
        <div className="bg-surface rounded-lg border border-outline p-6 mb-8">
          <h2 className="text-xl font-bold text-on-surface mb-4 flex items-center gap-2">
            <MapPin className="w-5 h-5 text-accent" />
            Route Evolution
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Travel Time */}
            {route_characteristics.travel_time_transition.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Travel Time Progression</h3>
                <SimpleLineChart
                  data={route_characteristics.travel_time_transition}
                  valueFormatter={(val) => `${(val / 60).toFixed(1)}h`}
                />
              </div>
            )}

            {/* Cost (one chart per currency) */}
            {Object.entries(route_characteristics.cost_transition).map(([symbol, series]) =>
              series.length > 0 ? (
                <div key={`cost-${symbol || "unknown"}`}>
                  <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">
                    Cost Progression{symbol ? ` (${symbol})` : ""}
                  </h3>
                  <SimpleLineChart
                    data={series}
                    valueFormatter={(val) => `${symbol}${val.toFixed(0)}`}
                  />
                </div>
              ) : null,
            )}

            {/* Destinations */}
            {route_characteristics.destination_count_transition.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Number of Destinations</h3>
                <SimpleLineChart
                  data={route_characteristics.destination_count_transition}
                  valueFormatter={(val) => `${val}`}
                />
              </div>
            )}

            {/* Coverage */}
            <div>
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Destination Coverage</h3>
              <div className="bg-surface-secondary rounded-lg p-4 flex flex-col items-center justify-center" style={{ height: '280px' }}>
                <div className="text-7xl font-bold text-accent mb-3">
                  {(route_characteristics.destination_coverage * 100).toFixed(0)}%
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm text-on-surface-secondary font-medium">
                    {route_characteristics.final_destinations_count} / {route_characteristics.total_proposed_destinations} destinations
                  </p>
                  <p className="text-xs text-on-surface-tertiary">
                    {route_characteristics.final_destinations_count} included in final route from {route_characteristics.total_proposed_destinations} proposed
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Voting Result */}
        {(discussion_dynamics.consensus?.approval?.total_votes ?? 0) > 0 && (
          <div className="bg-surface rounded-lg border border-outline p-6 mb-8">
            <h2 className="text-xl font-bold text-on-surface mb-4 flex items-center gap-2">
              <Vote className="w-5 h-5 text-accent" />
              Voting Result
            </h2>
            <div className="mb-4">
              <div className="flex justify-end mb-3">
                <div className="flex items-center gap-1 bg-surface-secondary rounded-lg p-0.5">
                  <button
                    onClick={() => setVoteViewMode("given")}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                      voteViewMode === "given"
                        ? "bg-accent text-white"
                        : "text-on-surface-tertiary hover:text-on-surface"
                    }`}
                  >
                    Given
                  </button>
                  <button
                    onClick={() => setVoteViewMode("received")}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                      voteViewMode === "received"
                        ? "bg-accent text-white"
                        : "text-on-surface-tertiary hover:text-on-surface"
                    }`}
                  >
                    Received
                  </button>
                </div>
              </div>
              <div className="text-center p-4 bg-surface-secondary rounded-lg">
                <div className="text-3xl font-bold text-accent mb-1">
                  {discussion_dynamics.consensus?.approval?.total_votes ?? 0}
                </div>
                <div className="text-sm text-on-surface-tertiary">Total Votes</div>
                <div className="text-xs text-on-surface-tertiary mt-1">
                  {(discussion_dynamics.consensus?.approval?.total_approval_votes ?? 0)} approval / {(discussion_dynamics.consensus?.approval?.total_reject_votes ?? 0)} reject
                </div>
              </div>
            </div>
            <div className="space-y-3">
              {agentNames.map((agentName) => {
                const approvalVotes =
                  voteViewMode === "given"
                    ? (
                      discussion_dynamics.consensus?.approval?.approval_votes_per_agent?.[agentName] ??
                      discussion_dynamics.consensus?.approval?.votes_per_agent?.[agentName] ??
                      0
                    )
                    : (discussion_dynamics.consensus?.approval?.received_approval_votes_per_agent?.[agentName] ?? 0);
                const rejectVotes =
                  voteViewMode === "given"
                    ? (discussion_dynamics.consensus?.approval?.reject_votes_per_agent?.[agentName] ?? 0)
                    : (discussion_dynamics.consensus?.approval?.received_reject_votes_per_agent?.[agentName] ?? 0);
                const totalVotes = approvalVotes + rejectVotes;
                if (totalVotes === 0) return null;
                const approvalPercent = (approvalVotes / totalVotes) * 100;
                const rejectPercent = (rejectVotes / totalVotes) * 100;

                return (
                  <div key={agentName} className="border-b border-outline last:border-0 pb-3 last:pb-0">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium text-on-surface text-sm">{agentName}</div>
                      <div className="text-sm text-on-surface-tertiary">
                        {approvalVotes} approval / {rejectVotes} reject
                      </div>
                    </div>
                    <div className="relative w-full bg-surface-tertiary rounded-full h-2 overflow-hidden">
                      <div
                        className="absolute left-0 top-0 h-2 bg-emerald-500 transition-all"
                        style={{ width: `${approvalPercent}%` }}
                      ></div>
                      <div
                        className="absolute right-0 top-0 h-2 bg-rose-500 transition-all"
                        style={{ width: `${rejectPercent}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Score-based Voting */}
        {(discussion_dynamics.consensus?.scoring?.total_votes ?? 0) > 0 && (
          <div className="bg-surface rounded-lg border border-outline p-6">
            <h2 className="text-xl font-bold text-on-surface mb-4 flex items-center gap-2">
              <Vote className="w-5 h-5 text-accent" />
              Score-based Voting
            </h2>

            {/* Overall Statistics */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Overall Score Distribution</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="text-center p-3 bg-surface-secondary rounded-lg">
                  <div className="text-2xl font-bold text-accent mb-1">
                    {discussion_dynamics.consensus?.scoring?.total_votes ?? 0}
                  </div>
                  <div className="text-xs text-on-surface-tertiary">Total Scores</div>
                </div>
                <div className="text-center p-3 bg-surface-secondary rounded-lg">
                  <div className="text-2xl font-bold text-on-surface mb-1">
                    {(discussion_dynamics.consensus?.scoring?.score_stats?.mean ?? 0).toFixed(1)}
                  </div>
                  <div className="text-xs text-on-surface-tertiary">Mean</div>
                </div>
                <div className="text-center p-3 bg-surface-secondary rounded-lg">
                  <div className="text-2xl font-bold text-on-surface mb-1">
                    {(discussion_dynamics.consensus?.scoring?.score_stats?.min ?? 0).toFixed(1)}
                  </div>
                  <div className="text-xs text-on-surface-tertiary">Min</div>
                </div>
                <div className="text-center p-3 bg-surface-secondary rounded-lg">
                  <div className="text-2xl font-bold text-on-surface mb-1">
                    {(discussion_dynamics.consensus?.scoring?.score_stats?.max ?? 0).toFixed(1)}
                  </div>
                  <div className="text-xs text-on-surface-tertiary">Max</div>
                </div>
                <div className="text-center p-3 bg-surface-secondary rounded-lg">
                  <div className="text-2xl font-bold text-on-surface mb-1">
                    {(discussion_dynamics.consensus?.scoring?.score_stats?.std ?? 0).toFixed(2)}
                  </div>
                  <div className="text-xs text-on-surface-tertiary">Std Dev</div>
                </div>
              </div>
            </div>

            {/* Score Distribution */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-on-surface-secondary">Score Distribution</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setScoreViewMode("given")}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      scoreViewMode === "given"
                        ? "bg-accent text-accent-text"
                        : "bg-surface-tertiary text-on-surface-secondary hover:bg-outline"
                    }`}
                  >
                    Given
                  </button>
                  <button
                    onClick={() => setScoreViewMode("received")}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      scoreViewMode === "received"
                        ? "bg-accent text-accent-text"
                        : "bg-surface-tertiary text-on-surface-secondary hover:bg-outline"
                    }`}
                  >
                    Received
                  </button>
                </div>
              </div>
              <div className="bg-surface-secondary rounded-lg p-4" style={{ height: '350px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(() => {
                      const scoresSource = scoreViewMode === "given"
                        ? discussion_dynamics.consensus?.scoring?.scores_by_agent
                        : discussion_dynamics.consensus?.scoring?.received_scores_by_agent;

                      if (!scoresSource) return [];

                      // Create bins for scores 0-10
                      const bins = Array.from({ length: 11 }, (_, i) => {
                        const bin: any = { score: i };
                        // For each agent, count frequency at this score
                        agentNames.forEach((agentName) => {
                          const agentScores = scoresSource[agentName] ?? [];
                          bin[agentName] = agentScores.filter(s => Math.round(s) === i).length;
                        });
                        return bin;
                      });
                      return bins;
                    })()}
                    margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={outlineColor} />
                    <XAxis
                      dataKey="score"
                      tick={{ fontSize: 12, fill: textTertiary }}
                      stroke={textTertiary}
                      label={{ value: 'Score', position: 'insideBottom', offset: -5, style: { fill: textTertiary } }}
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: textTertiary }}
                      stroke={textTertiary}
                      label={{ value: 'Frequency', angle: -90, position: 'insideLeft', style: { fill: textTertiary } }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: surfaceColor,
                        border: `1px solid ${outlineColor}`,
                        borderRadius: '0.5rem',
                        padding: '8px 12px',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                      }}
                    />
                    <Legend
                      wrapperStyle={{ paddingTop: '10px' }}
                      iconType="circle"
                    />
                    {agentNames.map((agentName, idx) => (
                      <Bar
                        key={agentName}
                        dataKey={agentName}
                        stackId="a"
                        fill={`hsl(${(idx * 360) / agentNames.length}, 70%, 50%)`}
                        name={agentName}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Per-Agent Statistics Table */}
            <div>
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">
                Detailed Statistics by Agent ({scoreViewMode === "given" ? "Scores Given" : "Scores Received"})
              </h3>
              <div className="space-y-3">
                {agentNames.map((agentName) => {
                  const statsSource = scoreViewMode === "given"
                    ? discussion_dynamics.consensus?.scoring?.score_stats_per_agent
                    : discussion_dynamics.consensus?.scoring?.received_score_stats_per_agent;
                  const agentStats = statsSource?.[agentName];
                  if (!agentStats) return null;

                  return (
                    <div key={agentName} className="border border-outline rounded-lg p-4">
                      <div className="font-medium text-on-surface mb-3">{agentName}</div>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="text-center">
                          <div className="text-lg font-bold text-accent">{agentStats.count}</div>
                          <div className="text-xs text-on-surface-tertiary">Scores</div>
                        </div>
                        <div className="text-center">
                          <div className="text-lg font-bold text-on-surface">{agentStats.mean.toFixed(1)}</div>
                          <div className="text-xs text-on-surface-tertiary">Mean</div>
                        </div>
                        <div className="text-center">
                          <div className="text-lg font-bold text-on-surface">{agentStats.min.toFixed(1)}</div>
                          <div className="text-xs text-on-surface-tertiary">Min</div>
                        </div>
                        <div className="text-center">
                          <div className="text-lg font-bold text-on-surface">{agentStats.max.toFixed(1)}</div>
                          <div className="text-xs text-on-surface-tertiary">Max</div>
                        </div>
                        <div className="text-center">
                          <div className="text-lg font-bold text-on-surface">{agentStats.std.toFixed(2)}</div>
                          <div className="text-xs text-on-surface-tertiary">Std</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
