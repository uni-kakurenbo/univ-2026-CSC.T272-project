#include "../common/agent_utils.hpp"

#include <cmath>
#include <iostream>
#include <string>
#include <vector>
#include <optional>
#include <numeric>

namespace {
using agent::Cell;
using agent::Direction;
using agent::DistanceMap;
using agent::Grid;
using agent::Json;
using agent::Point;

struct Observation {
    int turn = 0;
    std::string status;
    Point position;
    Point duck_position;
    std::optional<int> goal_distance;
};

struct SphinxIntelligence {
    explicit SphinxIntelligence(int level)
        : level(agent::clamp_intelligence_level(level)),
          is_random(this->level == 0),
          use_duck_tracker(this->level >= 1),
          use_goal_predictor(this->level >= 2),
          use_goal_distance_observation(this->level >= 2),
          use_observe_action(this->level >= 3),
          minimax_depth(this->level >= 3 ? 3 : (this->level >= 2 ? 1 : 0)),
          emit_telemetry(this->level >= 1) {}

    int level;
    bool is_random;
    bool use_duck_tracker;
    bool use_goal_predictor;
    bool use_goal_distance_observation;
    bool use_observe_action;
    int minimax_depth;
    bool emit_telemetry;
};

class GoalPredictor {
public:
    void initialize(const Grid& map, Point initial_duck_pos) {
        reset_belief(map, initial_duck_pos);

        duck_map_ = Grid(map.height(), map.width(), Cell::Unknown);
        update_duck_fov(map, initial_duck_pos);
    }

    void update_duck_fov(const Grid& actual_map, Point duck_pos) {
        constexpr int kFovRadius = 2;
        for (int dy = -kFovRadius; dy <= kFovRadius; ++dy) {
            for (int dx = -kFovRadius; dx <= kFovRadius; ++dx) {
                if (std::abs(dx) + std::abs(dy) <= kFovRadius) {
                    Point p{duck_pos.x + dx, duck_pos.y + dy};
                    if (actual_map.in_bounds(p)) {
                        duck_map_.set(p, actual_map.get(p));
                    }
                }
            }
        }
    }

    void update(const Grid& map, Point old_duck_pos, Point new_duck_pos, Point old_sphinx_pos) {
        if (old_duck_pos == new_duck_pos) return;

        update_duck_fov(map, new_duck_pos);

        auto passable = [&](Point p) { return duck_map_.passable(p, true); };
        auto dist_from_sphinx = agent::bfs_distances(duck_map_.height(), duck_map_.width(), old_sphinx_pos, passable);

        double total = 0.0;
        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                if (belief_[y][x] <= 0.0) continue;
                Point g{x, y};

                if (g == new_duck_pos) {
                    belief_[y][x] = 0.0;
                    continue;
                }

                auto dist_to_goal = agent::bfs_distances(duck_map_.height(), duck_map_.width(), g, passable);

                if (dist_to_goal.get(old_duck_pos) == DistanceMap::inf()) {
                    belief_[y][x] = 0.0;
                    continue;
                }

                int current_dist_s = dist_from_sphinx.get(old_duck_pos);
                if (current_dist_s == DistanceMap::inf()) {
                    current_dist_s = 50;
                }

                double d = static_cast<double>(current_dist_s);
                double goal_weight = 0.8 * (1.0 - std::exp(-0.3 * d));
                double escape_weight = 4.0 * std::exp(-0.7 * d);

                auto evaluate_position = [&](Point pos) -> double {
                    double dist_g = dist_to_goal.get(pos);
                    if (dist_g == DistanceMap::inf()) dist_g = 500.0;

                    double dist_s = dist_from_sphinx.get(pos);
                    if (dist_s == DistanceMap::inf()) dist_s = 50.0;

                    return -goal_weight * dist_g + escape_weight * std::min(dist_s, 4.0);
                };

                std::vector<double> action_utilities(5, -1e9);
                double max_utility = -1e9;
                auto directions = agent::all_directions();

                for (size_t i = 0; i < directions.size(); ++i) {
                    Direction act = directions[i];
                    Point next = agent::moved(old_duck_pos, act);
                    if (!duck_map_.in_bounds(next) || !duck_map_.passable(next, true)) {
                        if (act != Direction::Stay) continue;
                    }

                    double eu = 0.0;
                    for (const auto& [dir, prob] : agent::duck_slip_outcomes(act)) {
                        Point actual_next = agent::moved(old_duck_pos, dir);
                        if (!duck_map_.in_bounds(actual_next) || !duck_map_.passable(actual_next, true)) actual_next = old_duck_pos;
                        eu += prob * evaluate_position(actual_next);
                    }
                    action_utilities[i] = eu;
                    if (eu > max_utility) max_utility = eu;
                }

                std::vector<double> action_probs(5, 0.0);
                double sum_probs = 0.0;
                for (size_t i = 0; i < directions.size(); ++i) {
                    if (action_utilities[i] > -1e8) {
                        double p = std::exp(action_utilities[i] - max_utility);
                        action_probs[i] = p;
                        sum_probs += p;
                    }
                }

                double likelihood = 0.001;
                double p_random = 1.0 / directions.size();
                for (size_t i = 0; i < directions.size(); ++i) {
                    double p_rational = (action_probs[i] > 0.0 && sum_probs > 0.0) ? (action_probs[i] / sum_probs) : 0.0;
                    double p_act = 0.8 * p_rational + 0.2 * p_random;

                    double p_arrive = 0.0;
                    for (const auto& [dir, prob] : agent::duck_slip_outcomes(directions[i])) {
                        Point actual_next = agent::moved(old_duck_pos, dir);
                        if (!duck_map_.in_bounds(actual_next) || !duck_map_.passable(actual_next, true)) actual_next = old_duck_pos;
                        if (actual_next == new_duck_pos) p_arrive += prob;
                    }
                    likelihood += p_act * p_arrive;
                }

                belief_[y][x] *= likelihood;
                total += belief_[y][x];
            }
        }

        if (total > 0.0) {
            for (auto& row : belief_) {
                for (auto& val : row) val /= total;
            }
        } else {
            reset_belief(map, new_duck_pos);
        }

        update_duck_fov(map, new_duck_pos);
    }

    void apply_distance_observation(Point sphinx_pos, int observed_dist) {
        auto observation_std_dev = [](int distance) {
            constexpr double kMinStdDev = 0.5;
            constexpr double kMaxStdDev = 3.0;
            constexpr double kStdDevPerCell = 0.1;
            return std::min(kMaxStdDev, kMinStdDev + kStdDevPerCell * distance);
        };

        double total = 0.0;
        std::vector<std::vector<double>> log_weights(
            duck_map_.height(),
            std::vector<double>(duck_map_.width(), -std::numeric_limits<double>::infinity())
        );
        double max_log_weight = -std::numeric_limits<double>::infinity();

        for (int y = 0; y < duck_map_.height(); ++y) {
            for (int x = 0; x < duck_map_.width(); ++x) {
                if (belief_[y][x] <= 0.0) continue;

                int true_dist = std::abs(x - sphinx_pos.x) + std::abs(y - sphinx_pos.y);
                double std_dev = observation_std_dev(true_dist);
                double variance = std_dev * std_dev;
                double diff = static_cast<double>(true_dist - observed_dist);

                double log_weight = std::log(belief_[y][x]) - std::log(std_dev) - (diff * diff) / (2.0 * variance);
                log_weights[y][x] = log_weight;
                if (log_weight > max_log_weight) {
                    max_log_weight = log_weight;
                }
            }
        }

        if (!std::isfinite(max_log_weight)) return;

        for (int y = 0; y < duck_map_.height(); ++y) {
            for (int x = 0; x < duck_map_.width(); ++x) {
                if (belief_[y][x] <= 0.0) continue;
                double log_weight = log_weights[y][x];
                belief_[y][x] = std::isfinite(log_weight) ? std::exp(log_weight - max_log_weight) : 0.0;
                total += belief_[y][x];
            }
        }

        if (total > 0.0) {
            for (auto& row : belief_) {
                for (auto& val : row) val /= total;
            }
        }
    }

    Point peak() const { return agent::argmax_distribution(belief_); }
    double confidence() const { return std::clamp(1.0 - agent::normalized_entropy(belief_), 0.0, 1.0); }
    const std::vector<std::vector<double>>& values() const { return belief_; }

private:
    void reset_belief(const Grid& map, Point excluded_position) {
        belief_.assign(map.height(), std::vector<double>(map.width(), 0.0));

        int valid_count = 0;
        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                Point p{x, y};
                if (map.passable(p, false) && p != excluded_position) {
                    belief_[y][x] = 1.0;
                    valid_count++;
                }
            }
        }

        if (valid_count > 0) {
            for (auto& row : belief_) {
                for (auto& val : row) val /= valid_count;
            }
        }
    }

    std::vector<std::vector<double>> belief_;
    Grid duck_map_;
};

class DuckTracker {
public:
    void initialize(const Grid& map, Point observed_duck_pos, Point sphinx_pos) {
        duck_belief_.assign(map.height(), std::vector<double>(map.width(), 0.0));
        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                if (map.passable({x, y}, false)) duck_belief_[y][x] = 1.0;
            }
        }
        apply_observation(map, observed_duck_pos, sphinx_pos);
    }

    void update(const Grid& map, Point observed_duck_pos, Point sphinx_pos, const std::vector<std::vector<double>>* goal_belief = nullptr) {
        std::vector<std::vector<double>> next_belief(map.height(), std::vector<double>(map.width(), 0.0));

        std::vector<std::vector<double>> expected_goal_dist;
        if (goal_belief) {
            expected_goal_dist.assign(map.height(), std::vector<double>(map.width(), 0.0));
            const auto& gb = *goal_belief;
            for (int y = 0; y < map.height(); ++y) {
                for (int x = 0; x < map.width(); ++x) {
                    if (!map.passable({x, y}, false)) continue;
                    double dist = 0;
                    for (int gy = 0; gy < map.height(); ++gy) {
                        for (int gx = 0; gx < map.width(); ++gx) {
                            if (gb[gy][gx] > 0.0) {
                                dist += gb[gy][gx] * (std::abs(x - gx) + std::abs(y - gy));
                            }
                        }
                    }
                    expected_goal_dist[y][x] = dist;
                }
            }
        }

        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                if (duck_belief_[y][x] > 0.0) {
                    Point from{x, y};
                    std::vector<Point> valid_moves;
                    valid_moves.push_back(from);
                    for (auto dir : agent::move_directions()) {
                        Point next = agent::moved(from, dir);
                        if (map.in_bounds(next) && map.passable(next, false)) {
                            valid_moves.push_back(next);
                        }
                    }

                    if (goal_belief) {
                        std::vector<double> weights(valid_moves.size(), 0.0);
                        double weight_sum = 0.0;
                        for (size_t i = 0; i < valid_moves.size(); ++i) {
                            Point p = valid_moves[i];
                            weights[i] = std::exp(-0.5 * expected_goal_dist[p.y][p.x]);
                            weight_sum += weights[i];
                        }
                        for (size_t i = 0; i < valid_moves.size(); ++i) {
                            double prob = duck_belief_[y][x] * (weights[i] / weight_sum);
                            Point p = valid_moves[i];
                            next_belief[p.y][p.x] += prob;
                        }
                    } else {
                        double prob = duck_belief_[y][x] / valid_moves.size();
                        for (const auto& p : valid_moves) {
                            next_belief[p.y][p.x] += prob;
                        }
                    }
                }
            }
        }

        duck_belief_ = std::move(next_belief);
        apply_observation(map, observed_duck_pos, sphinx_pos);
    }

    Point estimate() const {
        return agent::argmax_distribution(duck_belief_);
    }

    double confidence() const {
        return std::clamp(1.0 - agent::normalized_entropy(duck_belief_), 0.0, 1.0);
    }

    const std::vector<std::vector<double>>& values() const {
        return duck_belief_;
    }

private:
    static double observation_std_dev(int distance) {
        constexpr double kMinStdDev = 0.5;
        constexpr double kMaxStdDev = 3.0;
        constexpr double kStdDevPerCell = 0.1;
        return std::min(kMaxStdDev, kMinStdDev + kStdDevPerCell * distance);
    }

    void apply_observation(const Grid& map, Point observation, Point sphinx_pos) {
        const auto passable = [&](Point point) { return map.passable(point, false); };
        const auto distances_from_sphinx =
            agent::bfs_distances(map.height(), map.width(), sphinx_pos, passable);
        std::vector<std::vector<double>> log_weights(
            map.height(),
            std::vector<double>(map.width(), -std::numeric_limits<double>::infinity())
        );
        double max_log_weight = -std::numeric_limits<double>::infinity();

        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                if (duck_belief_[y][x] <= 0.0) continue;

                const int path_distance = distances_from_sphinx.get({x, y});
                if (path_distance == DistanceMap::inf()) continue;

                const double std_dev = observation_std_dev(path_distance);
                const double variance = std_dev * std_dev;
                const double dx = static_cast<double>(x - observation.x);
                const double dy = static_cast<double>(y - observation.y);
                const double log_weight = std::log(duck_belief_[y][x])
                    - std::log(variance)
                    - (dx * dx + dy * dy) / (2.0 * variance);
                log_weights[y][x] = log_weight;
                max_log_weight = std::max(max_log_weight, log_weight);
            }
        }

        if (!std::isfinite(max_log_weight)) {
            reset_to_uniform(map);
            return;
        }

        double total = 0.0;
        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                const double log_weight = log_weights[y][x];
                duck_belief_[y][x] =
                    std::isfinite(log_weight) ? std::exp(log_weight - max_log_weight) : 0.0;
                total += duck_belief_[y][x];
            }
        }

        for (auto& row : duck_belief_) {
            for (auto& value : row) value /= total;
        }
    }

    void reset_to_uniform(const Grid& map) {
        int passable_count = 0;
        for (int y = 0; y < map.height(); ++y) {
            for (int x = 0; x < map.width(); ++x) {
                const bool is_passable = map.passable({x, y}, false);
                duck_belief_[y][x] = is_passable ? 1.0 : 0.0;
                passable_count += is_passable ? 1 : 0;
            }
        }

        if (passable_count == 0) return;
        for (auto& row : duck_belief_) {
            for (auto& value : row) value /= passable_count;
        }
    }

    std::vector<std::vector<double>> duck_belief_;
};

class SphinxAgent {
public:
    explicit SphinxAgent(int intelligence_level) : intelligence_(intelligence_level) {}

    void handle_init(const Json& message) {
        const auto dimensions = agent::map_size_to_dimensions(message.at("map_size"));
        map_ = Grid(dimensions.y, dimensions.x, Cell::Wall);
        const auto raw_map = agent::parse_int_grid(message.at("full_map"));
        for (int y = 0; y < static_cast<int>(raw_map.size()); ++y) {
            for (int x = 0; x < static_cast<int>(raw_map[y].size()); ++x) {
                const auto cell = agent::cell_from_int(raw_map[y][x]);
                map_.set({x, y}, cell == Cell::Unknown ? Cell::Empty : cell);
            }
        }
        initialized_predictor_ = false;
        std::cerr << "[sphinx] initialized " << dimensions.x << "x" << dimensions.y << " level=" << intelligence_.level << std::endl;
    }

    Direction decide(const Observation& observation) {
        if (observation.status != "ACTIVE") return Direction::Stay;

        update_estimates(observation);
        last_sphinx_pos_ = observation.position;

        auto passable = [&](Point p) { return map_.passable(p, false); };

        if (intelligence_.is_random) {
            std::vector<Direction> valid_moves;
            for (const auto direction : agent::move_directions()) {
                if (map_.in_bounds(agent::moved(observation.position, direction)) && passable(agent::moved(observation.position, direction))) {
                    valid_moves.push_back(direction);
                }
            }
            if (valid_moves.empty()) return Direction::Stay;
            return random_.choice(valid_moves);
        }

        auto dist_from_s = agent::bfs_distances(map_.height(), map_.width(), observation.position, passable);

        int est_duck_dist = dist_from_s.get(last_estimated_duck_pos_);
        if (est_duck_dist == DistanceMap::inf()) est_duck_dist = 1000;

        const auto& goal_belief = predictor_.values();
        if (should_observe(observation, est_duck_dist, goal_belief)) {
            last_observe_pos_ = observation.position;
            return Direction::Observe;
        }

        Direction best_action = Direction::Stay;
        double best_score = -1e9;

        for (Direction dir : agent::move_directions()) {
            Point next = agent::moved(observation.position, dir);
            if (!map_.in_bounds(next) || !passable(next)) continue;

            double score = intelligence_.minimax_depth > 0
                ? minimax(next, last_estimated_duck_pos_, intelligence_.minimax_depth, false, -1e9, 1e9, goal_belief)
                : evaluate_state(next, last_estimated_duck_pos_, goal_belief);

            if (score > best_score) {
                best_score = score;
                best_action = dir;
            }
        }

        return best_action;
    }

    double evaluate_state(Point sphinx_pos, Point duck_pos, const std::vector<std::vector<double>>& goal_belief) const {
        auto passable = [&](Point p) { return map_.passable(p, false); };
        auto dist_from_s = agent::bfs_distances(map_.height(), map_.width(), sphinx_pos, passable);
        auto dist_from_d = agent::bfs_distances(map_.height(), map_.width(), duck_pos, passable);

        int dist_duck = dist_from_s.get(duck_pos);
        if (dist_duck == DistanceMap::inf()) dist_duck = 1000;

        double expected_s_goal_dist = 0.0;
        double expected_d_goal_dist = 0.0;
        for (int y = 0; y < map_.height(); ++y) {
            for (int x = 0; x < map_.width(); ++x) {
                if (goal_belief[y][x] > 0.0) {
                    int d_s = dist_from_s.get({x, y});
                    int d_d = dist_from_d.get({x, y});
                    expected_s_goal_dist += goal_belief[y][x] * (d_s != DistanceMap::inf() ? d_s : 1000.0);
                    expected_d_goal_dist += goal_belief[y][x] * (d_d != DistanceMap::inf() ? d_d : 1000.0);
                }
            }
        }

        return -1.1 * static_cast<double>(dist_duck) - 1.0 * expected_s_goal_dist + 1.0 * expected_d_goal_dist;
    }

    double minimax(Point sphinx_pos, Point duck_pos, int depth, bool is_sphinx_turn, double alpha, double beta, const std::vector<std::vector<double>>& goal_belief) const {
        if (depth == 0 || sphinx_pos == duck_pos) {
            return evaluate_state(sphinx_pos, duck_pos, goal_belief);
        }

        auto passable_s = [&](Point p) { return map_.passable(p, false); };
        auto passable_d = [&](Point p) { return map_.passable(p, true); };

        if (is_sphinx_turn) {
            double max_eval = -1e9;
            for (Direction dir : agent::move_directions()) {
                Point next_s = agent::moved(sphinx_pos, dir);
                if (!map_.in_bounds(next_s) || !passable_s(next_s)) continue;

                double eval = minimax(next_s, duck_pos, depth - 1, false, alpha, beta, goal_belief);
                max_eval = std::max(max_eval, eval);
                alpha = std::max(alpha, eval);
                if (beta <= alpha) break;
            }
            return max_eval;
        } else {
            double min_eval = 1e9;
            for (Direction dir : agent::move_directions()) {
                Point next_d = agent::moved(duck_pos, dir);
                if (!map_.in_bounds(next_d) || !passable_d(next_d)) continue;

                double eval = minimax(sphinx_pos, next_d, depth - 1, true, alpha, beta, goal_belief);
                min_eval = std::min(min_eval, eval);
                beta = std::min(beta, eval);
                if (beta <= alpha) break;
            }
            return min_eval;
        }
    }

    std::string response(Direction action) const {
        const std::string command = "ACTION: " + std::string(agent::to_string(action));
        if (!intelligence_.emit_telemetry) return agent::response_envelope(command);

        agent::TargetEstimate duck_est{
            duck_tracker_.estimate(),
            duck_tracker_.values(),
            duck_tracker_.confidence()
        };
        agent::TargetEstimate goal_est{predictor_.peak(), predictor_.values(), predictor_.confidence()};
        return agent::response_envelope(
            command,
            duck_est,
            goal_est
        );
    }

private:
    void update_estimates(const Observation& observation) {
        if (!initialized_predictor_) {
            duck_tracker_.initialize(map_, observation.duck_position, observation.position);
            last_estimated_duck_pos_ = intelligence_.use_duck_tracker
                ? duck_tracker_.estimate()
                : observation.duck_position;
            predictor_.initialize(map_, last_estimated_duck_pos_);
            initialized_predictor_ = true;
            return;
        }

        if (intelligence_.use_duck_tracker) {
            const auto* goal_belief = intelligence_.use_goal_predictor ? &predictor_.values() : nullptr;
            duck_tracker_.update(map_, observation.duck_position, observation.position, goal_belief);
            Point current_estimated_duck_pos = duck_tracker_.estimate();
            if (intelligence_.use_goal_predictor && last_estimated_duck_pos_ != current_estimated_duck_pos) {
                predictor_.update(map_, last_estimated_duck_pos_, current_estimated_duck_pos, last_sphinx_pos_);
            }
            last_estimated_duck_pos_ = current_estimated_duck_pos;
        } else {
            last_estimated_duck_pos_ = observation.duck_position;
        }

        if (
            intelligence_.use_goal_predictor &&
            intelligence_.use_goal_distance_observation &&
            observation.goal_distance.has_value()
        ) {
            predictor_.apply_distance_observation(observation.position, observation.goal_distance.value());
        }
    }

    bool should_observe(
        const Observation& observation,
        int estimated_duck_distance,
        const std::vector<std::vector<double>>& goal_belief
    ) const {
        if (!intelligence_.use_goal_predictor || !intelligence_.use_observe_action) return false;

        double expected_dist = 0.0;
        double expected_sq_dist = 0.0;
        for (int y = 0; y < map_.height(); ++y) {
            for (int x = 0; x < map_.width(); ++x) {
                if (goal_belief[y][x] > 0.0) {
                    double d = static_cast<double>(std::abs(x - observation.position.x) + std::abs(y - observation.position.y));
                    expected_dist += goal_belief[y][x] * d;
                    expected_sq_dist += goal_belief[y][x] * (d * d);
                }
            }
        }
        double variance = expected_sq_dist - (expected_dist * expected_dist);
        int dist_from_last_obs = std::abs(last_observe_pos_.x - observation.position.x) + std::abs(last_observe_pos_.y - observation.position.y);
        return predictor_.confidence() < 0.5 && estimated_duck_distance > 5 && variance > 4.0 && dist_from_last_obs >= 3;
    }

    SphinxIntelligence intelligence_;
    Grid map_;
    DuckTracker duck_tracker_;
    GoalPredictor predictor_;
    agent::RandomSource random_;
    Point last_estimated_duck_pos_{0, 0};
    Point last_sphinx_pos_{0, 0};
    Point last_observe_pos_{-100, -100};
    bool initialized_predictor_ = false;
};

Observation parse_observation(const Json& message) {
    Observation observation;
    observation.turn = message.at("turn").as_int();
    observation.status = message.at("status").as_string("ACTIVE");
    observation.position = agent::parse_point(message.at("pos"));
    observation.duck_position = agent::parse_point(message.at("duck_pos"));
    if (message.has("goal_distance")) {
        observation.goal_distance = message.at("goal_distance").as_int();
    }
    return observation;
}

}  // namespace

int main(int argc, char* argv[]) {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    SphinxAgent agent(agent::parse_intelligence_level(argc, argv));
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        try {
            const auto message = Json::parse(line);
            if (!message.has("turn")) {
                agent.handle_init(message);
                continue;
            }

            const auto action = agent.decide(parse_observation(message));
            std::cout << agent.response(action) << std::endl;
        } catch (const std::exception& error) {
            std::cerr << "[sphinx] fallback after error: " << error.what() << std::endl;
            std::cout << "ACTION: STAY" << std::endl;
        }
    }

    return 0;
}
