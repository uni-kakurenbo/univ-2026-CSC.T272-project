#include "../common/agent_utils.hpp"

#include <cmath>
#include <iostream>
#include <numeric>
#include <ranges>
#include <string>
#include <vector>

namespace {
using agent::Cell;
using agent::Direction;
using agent::DistanceMap;
using agent::Grid;
using agent::Json;
using agent::Point;

constexpr double kUnknownPenalty = 2.0;
constexpr double kSlipProbability = 0.2;
constexpr double kCollisionWeight = 140.0;
constexpr double kRiskRoutingCost = 8.0;
constexpr double kGoalWeight = 6.0;
constexpr double kUnreachableCost = 500.0;

struct Observation {
    int turn = 0;
    std::string status;
    Point position;
    int fov_radius = 0;
    std::vector<std::vector<int>> fov;
    int sound = 0;
    int heat = 0;
    double radio = -1.0;
    std::string compass = "UNKNOWN";
    std::optional<Point> sphinx_pos;
};

struct DuckIntelligence {
    explicit DuckIntelligence(int level)
        : level(agent::clamp_intelligence_level(level)),
          is_random(this->level == 0),
          use_radar(this->level >= 1),
          use_sensor_likelihood(this->level >= 2),
          use_radio_compass(this->level >= 2),
          use_forecast(this->level >= 2),
          use_risk_routing(this->level >= 1),
          use_adversarial_planning(this->level >= 1),
          adversarial_depth(this->level >= 3 ? 5 : (this->level >= 2 ? 3 : (this->level >= 1 ? 1 : 0))),
          emit_telemetry(this->level >= 1) {}

    int level;
    bool is_random;
    bool use_radar;
    bool use_sensor_likelihood;
    bool use_radio_compass;
    bool use_forecast;
    bool use_risk_routing;
    bool use_adversarial_planning;
    int adversarial_depth;
    bool emit_telemetry;
};

class LocalMap {
public:
    void initialize(int height, int width, Point goal) {
        grid_ = Grid(height, width, Cell::Unknown);
        goal_ = goal;
        grid_.set(goal, Cell::Goal);
    }

    bool ready() const { return grid_.height() > 0 && grid_.width() > 0; }
    int height() const { return grid_.height(); }
    int width() const { return grid_.width(); }
    Point goal() const { return goal_; }

    void update_field_of_view(const Observation& observation) {
        const int radius = observation.fov_radius;
        for (int row = 0; row < static_cast<int>(observation.fov.size()); ++row) {
            for (int col = 0; col < static_cast<int>(observation.fov[row].size()); ++col) {
                const Point point{observation.position.x + col - radius, observation.position.y + row - radius};
                if (!grid_.in_bounds(point)) continue;
                const auto cell = agent::cell_from_int(observation.fov[row][col]);
                if (cell != Cell::Unknown) grid_.set(point, cell);
            }
        }
        grid_.set(observation.position, Cell::Empty);
        grid_.set(goal_, Cell::Goal);
    }

    bool passable(Point point) const { return grid_.passable(point, true); }

    double traversal_cost(Point point) const {
        const auto cell = grid_.get(point);
        if (cell == Cell::Wall) return 1e9;
        if (cell == Cell::Unknown) return 1.0 + kUnknownPenalty;
        return 1.0;
    }

    const Grid& grid() const { return grid_; }

private:
    Grid grid_;
    Point goal_;
};

class ValueField {
public:
    void recompute(const LocalMap& map) {
        recompute(map, [](Point) { return 0.0; });
    }

    template <class Risk>
    void recompute(const LocalMap& map, Risk risk) {
        values_.assign(map.height(), std::vector<double>(map.width(), 1e9));
        if (!map.grid().in_bounds(map.goal())) return;

        using QueueItem = std::pair<double, Point>;
        auto greater = [](const QueueItem& lhs, const QueueItem& rhs) { return lhs.first > rhs.first; };
        std::priority_queue<QueueItem, std::vector<QueueItem>, decltype(greater)> queue(greater);

        values_[map.goal().y][map.goal().x] = 0.0;
        queue.push({0.0, map.goal()});

        while (!queue.empty()) {
            const auto [current_cost, current] = queue.top();
            queue.pop();
            if (current_cost > value(current) + 1e-9) continue;

            for (const auto direction : agent::move_directions()) {
                const auto next = agent::moved(current, direction);
                if (!map.grid().in_bounds(next) || !map.passable(next)) continue;
                const double next_cost = current_cost + map.traversal_cost(next) + risk(next);
                if (next_cost + 1e-9 < value(next)) {
                    values_[next.y][next.x] = next_cost;
                    queue.push({next_cost, next});
                }
            }
        }
    }

    double value(Point point) const {
        if (point.y < 0 || point.y >= static_cast<int>(values_.size())) return 1e9;
        if (point.x < 0 || point.x >= static_cast<int>(values_[point.y].size())) return 1e9;
        return values_[point.y][point.x];
    }

private:
    std::vector<std::vector<double>> values_;
};

class NaiveBayesRadar {
public:
    void update(const LocalMap& map, const Observation& observation, const DuckIntelligence& intelligence) {
        if (!initialized_) {
            danger_.assign(map.height(), std::vector<double>(map.width(), 0.0));
            int valid_count = 0;
            for (int y = 0; y < map.height(); ++y) {
                for (int x = 0; x < map.width(); ++x) {
                    Point p{x, y};
                    if (map.passable(p) && p != observation.position) {
                        danger_[y][x] = 1.0;
                        valid_count++;
                    }
                }
            }
            if (valid_count > 0) {
                for (auto& row : danger_) {
                    for (auto& val : row) val /= valid_count;
                }
            }
            initialized_ = true;
        }

        if (observation.sphinx_pos) {
            danger_.assign(map.height(), std::vector<double>(map.width(), 0.0));
            if (map.grid().in_bounds(*observation.sphinx_pos)) {
                danger_[observation.sphinx_pos->y][observation.sphinx_pos->x] = 1.0;
            }
            return;
        }

        if (!intelligence.use_radar) return;

        auto passable = [&](Point p) { return map.passable(p); };
        const auto distance_to_duck = agent::bfs_distances(map.height(), map.width(), observation.position, passable);
        auto transition = [&](Point from) { return enemy_transition(map, distance_to_duck, from); };

        const auto prior_belief = agent::propagate_belief(map.height(), map.width(), danger_, transition, passable);

        if (!intelligence.use_sensor_likelihood) {
            danger_ = prior_belief;
            return;
        }

        double total = 0.0;

        for (const auto [y, x] : std::views::cartesian_product(std::views::iota(0, map.height()), std::views::iota(0, map.width()))) {
            const Point point{x, y};
            if (!map.passable(point) || point == observation.position) {
                danger_[y][x] = 0.0;
                continue;
            }

            int dy = point.y - observation.position.y;
            int dx = point.x - observation.position.x;
            int radius = observation.fov_radius;
            bool in_fov = false;
            if (std::abs(dy) <= radius && std::abs(dx) <= radius) {
                int row = dy + radius;
                int col = dx + radius;
                if (row >= 0 && row < static_cast<int>(observation.fov.size()) &&
                    col >= 0 && col < static_cast<int>(observation.fov[row].size())) {
                    if (agent::cell_from_int(observation.fov[row][col]) != Cell::Unknown) {
                        in_fov = true;
                    }
                }
            }
            if (in_fov) {
                danger_[y][x] = 0.0;
                continue;
            }

            const int distance = distance_to_duck.get(point);
            double prior = prior_belief[y][x];

            double likelihood = 1.0;
            likelihood *= agent::observation_likelihood(observation.sound, agent::probability_of_sensor("sound", distance));
            likelihood *= agent::observation_likelihood(observation.heat, agent::probability_of_sensor("heat", distance));

            if (intelligence.use_radio_compass && observation.radio >= 0.0) {
                double std_dev = 2.0 + distance * 0.1;
                likelihood *= agent::observation_likelihood_normal(observation.radio, static_cast<double>(distance), std_dev);
            }

            if (intelligence.use_radio_compass && observation.compass != "UNKNOWN") {
                double compass_prob = 0.25;
                if (point != observation.position) {
                     double dx = point.x - observation.position.x;
                     double dy = point.y - observation.position.y;
                     double dist = std::hypot(dx, dy);
                     double nx = dx / dist;
                     double ny = dy / dist;

                     double k = 2.0;
                     double baseline = 0.5;
                     double weight_right = std::exp(k * nx) + baseline;
                     double weight_left = std::exp(k * -nx) + baseline;
                     double weight_down = std::exp(k * ny) + baseline;
                     double weight_up = std::exp(k * -ny) + baseline;

                     double total_weight = weight_right + weight_left + weight_down + weight_up;

                     if (observation.compass == "RIGHT") {
                         compass_prob = weight_right / total_weight;
                     } else if (observation.compass == "LEFT") {
                         compass_prob = weight_left / total_weight;
                     } else if (observation.compass == "DOWN") {
                         compass_prob = weight_down / total_weight;
                     } else if (observation.compass == "UP") {
                         compass_prob = weight_up / total_weight;
                     } else {
                         compass_prob = 0.0;
                     }
                }
                likelihood *= compass_prob;
            }

            double posterior = prior * likelihood;
            danger_[y][x] = posterior;
            total += posterior;
        }

        if (total > 0.0) {
            for (auto& row : danger_) {
                for (auto& value : row) value /= total;
            }
        } else {
            danger_ = prior_belief;
        }
    }

    double at(Point point) const {
        if (point.y < 0 || point.y >= static_cast<int>(danger_.size())) return 0.0;
        if (point.x < 0 || point.x >= static_cast<int>(danger_[point.y].size())) return 0.0;
        return danger_[point.y][point.x];
    }

    Point peak() const { return agent::argmax_distribution(danger_); }

    double confidence() const {
        return std::clamp(1.0 - agent::normalized_entropy(danger_), 0.0, 1.0);
    }

    const std::vector<std::vector<double>>& values() const { return danger_; }

private:
    static std::vector<std::pair<Direction, double>> enemy_transition(
        const LocalMap& map, const DistanceMap& distance_to_duck, Point from
    ) {
        std::vector<Direction> moves;
        for (const auto direction : agent::move_directions()) {
            if (map.passable(agent::moved(from, direction))) moves.push_back(direction);
        }

        if (moves.empty()) return {{Direction::Stay, 1.0}};

        std::vector<Direction> best_moves;
        int best = distance_to_duck.get(from);

        for (const auto direction : moves) {
            const int candidate = distance_to_duck.get(agent::moved(from, direction));
            if (candidate < best) {
                best = candidate;
                best_moves.clear();
                best_moves.push_back(direction);
            } else if (candidate == best && !best_moves.empty()) {
                best_moves.push_back(direction);
            }
        }

        std::vector<std::pair<Direction, double>> transitions;
        double uniform = 0.4 / moves.size();

        if (best_moves.empty()) {
             for (const auto direction : moves) {
                transitions.push_back({direction, (0.6 / moves.size()) + uniform});
            }
        } else {
            double share = 0.6 / best_moves.size();
            for (const auto direction : moves) {
                bool is_best = std::find(best_moves.begin(), best_moves.end(), direction) != best_moves.end();
                transitions.push_back({direction, (is_best ? share : 0.0) + uniform});
            }
        }
        return transitions;
    }



    std::vector<std::vector<double>> danger_;
    bool initialized_ = false;
};


class EnemyForecast {
public:
    void compute(const LocalMap& map, const NaiveBayesRadar& radar, Point self) {
        const int height = map.height();
        const int width = map.width();
        risk_.assign(height, std::vector<double>(width, 0.0));

        auto passable = [&](Point p) { return map.passable(p); };
        const auto distance_to_duck = agent::bfs_distances(height, width, self, passable);
        auto transition = [&](Point from) { return enemy_transition(map, distance_to_duck, from); };

        const auto after_one = agent::propagate_belief(height, width, radar.values(), transition, passable);

        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const double occupied_now = radar.at({x, y});
                const double occupied_next = after_one[y][x];
                risk_[y][x] = std::min(1.0, occupied_now + occupied_next);
            }
        }
    }

    double at(Point point) const {
        if (point.y < 0 || point.y >= static_cast<int>(risk_.size())) return 0.0;
        if (point.x < 0 || point.x >= static_cast<int>(risk_[point.y].size())) return 0.0;
        return risk_[point.y][point.x];
    }

private:
    static std::vector<std::pair<Direction, double>> enemy_transition(
        const LocalMap& map, const DistanceMap& distance_to_duck, Point from
    ) {
        std::vector<Direction> moves;
        for (const auto direction : agent::move_directions()) {
            if (map.passable(agent::moved(from, direction))) moves.push_back(direction);
        }

        if (moves.empty()) return {{Direction::Stay, 1.0}};

        Direction chase = Direction::Stay;
        int best = distance_to_duck.get(from);
        for (const auto direction : moves) {
            const int candidate = distance_to_duck.get(agent::moved(from, direction));
            if (candidate < best) {
                best = candidate;
                chase = direction;
            }
        }

        return {{chase, 1.0}};
    }

    std::vector<std::vector<double>> risk_;
};

class AdversarialPlanner {
public:
    Direction choose_action(
        const LocalMap& map,
        const ValueField& values,
        Point sphinx_peak,
        Point self,
        Point last_position,
        int max_depth
    ) const {
        int w = map.width();
        int h = map.height();

        std::vector<std::vector<DistanceMap>> bfs_cache(h, std::vector<DistanceMap>(w, DistanceMap(0,0,0)));
        std::vector<std::vector<bool>> bfs_cached(h, std::vector<bool>(w, false));

        std::vector<std::vector<DistanceMap>> sphinx_bfs_cache(h, std::vector<DistanceMap>(w, DistanceMap(0,0,0)));
        std::vector<std::vector<bool>> sphinx_bfs_cached(h, std::vector<bool>(w, false));

        int memo_size = 6 * h * w * h * w;
        std::vector<double> memo(memo_size, 0.0);
        std::vector<bool> memo_valid(memo_size, false);

        auto intendable = agent::all_directions()
            | std::views::filter([&](Direction action) { return can_intend(map, self, action); });

        Direction best_action = Direction::Stay;
        double best_score = -1e9;

        for (Direction action : intendable) {
            double score = evaluate_action(map, values, self, sphinx_peak, action, 0, max_depth,
                                           bfs_cache, bfs_cached, sphinx_bfs_cache, sphinx_bfs_cached,
                                           memo, memo_valid);
            if (action != Direction::Stay && agent::moved(self, action) == last_position) {
                score -= 10.0;
            }
            if (score > best_score) {
                best_score = score;
                best_action = action;
            }
        }
        return best_action;
    }

private:
    static bool can_intend(const LocalMap& map, Point self, Direction action) {
        if (action == Direction::Stay) return true;
        const Point next = agent::moved(self, action);
        return map.grid().in_bounds(next) && map.passable(next);
    }

    double evaluate_state(
        const LocalMap& map,
        const ValueField& values,
        Point duck_pos,
        Point sphinx_pos,
        int depth,
        int max_depth,
        std::vector<std::vector<DistanceMap>>& bfs_cache,
        std::vector<std::vector<bool>>& bfs_cached,
        std::vector<std::vector<DistanceMap>>& sphinx_bfs_cache,
        std::vector<std::vector<bool>>& sphinx_bfs_cached,
        std::vector<double>& memo,
        std::vector<bool>& memo_valid
    ) const {
        int w = map.width();
        int h = map.height();
        int idx = depth * (h * w * h * w)
                + duck_pos.y * (w * h * w) + duck_pos.x * (h * w)
                + sphinx_pos.y * w + sphinx_pos.x;

        if (memo_valid[idx]) return memo[idx];

        auto intendable = agent::all_directions()
            | std::views::filter([&](Direction a) { return can_intend(map, duck_pos, a); });

        double max_score = -1e9;
        for (Direction action : intendable) {
            double score = evaluate_action(map, values, duck_pos, sphinx_pos, action, depth, max_depth,
                                           bfs_cache, bfs_cached, sphinx_bfs_cache, sphinx_bfs_cached,
                                           memo, memo_valid);
            if (score > max_score) max_score = score;
        }

        memo[idx] = max_score;
        memo_valid[idx] = true;
        return max_score;
    }

    double evaluate_action(
        const LocalMap& map,
        const ValueField& values,
        Point duck_pos,
        Point sphinx_pos,
        Direction duck_action,
        int depth,
        int max_depth,
        std::vector<std::vector<DistanceMap>>& bfs_cache,
        std::vector<std::vector<bool>>& bfs_cached,
        std::vector<std::vector<DistanceMap>>& sphinx_bfs_cache,
        std::vector<std::vector<bool>>& sphinx_bfs_cached,
        std::vector<double>& memo,
        std::vector<bool>& memo_valid
    ) const {

        double expected_score = 0.0;
        double stay_penalty = (duck_action == Direction::Stay && duck_pos != map.goal()) ? -6.0 : 0.0;

        for (const auto [direction, probability] : slip_outcomes(duck_action)) {
            Point next_duck = agent::moved(duck_pos, direction);
            if (!map.grid().in_bounds(next_duck) || !map.passable(next_duck)) next_duck = duck_pos;

            if (next_duck == map.goal()) {
                expected_score += probability * (1000.0 + stay_penalty);
                continue;
            }
            if (next_duck == sphinx_pos) {
                expected_score += probability * (-1000.0 + stay_penalty);
                continue;
            }

            auto passable = [&](Point p) { return map.passable(p); };

            if (!bfs_cached[next_duck.y][next_duck.x]) {
                bfs_cache[next_duck.y][next_duck.x] = agent::bfs_distances(map.height(), map.width(), next_duck, passable);
                bfs_cached[next_duck.y][next_duck.x] = true;
            }
            const auto& distance_to_duck = bfs_cache[next_duck.y][next_duck.x];

            Point next_sphinx = sphinx_pos;
            int best_dist = distance_to_duck.get(sphinx_pos);
            for (const auto dir : agent::move_directions()) {
                Point candidate = agent::moved(sphinx_pos, dir);
                if (map.grid().in_bounds(candidate) && map.passable(candidate)) {
                    int dist = distance_to_duck.get(candidate);
                    if (dist < best_dist) {
                        best_dist = dist;
                        next_sphinx = candidate;
                    }
                }
            }

            if (next_duck == next_sphinx) {
                expected_score += probability * (-1000.0 + stay_penalty);
                continue;
            }

            if (depth + 1 >= max_depth) {
                const double cost_to_goal = std::min(values.value(next_duck), kUnreachableCost);
                const double goal_term = -kGoalWeight * cost_to_goal;
                const double tie_break = -0.05 * agent::manhattan(next_duck, map.goal());

                if (!sphinx_bfs_cached[next_sphinx.y][next_sphinx.x]) {
                    sphinx_bfs_cache[next_sphinx.y][next_sphinx.x] = agent::bfs_distances(map.height(), map.width(), next_sphinx, passable);
                    sphinx_bfs_cached[next_sphinx.y][next_sphinx.x] = true;
                }
                int dist_to_sphinx = sphinx_bfs_cache[next_sphinx.y][next_sphinx.x].get(next_duck);
                double proximity_penalty = (dist_to_sphinx <= 2) ? -100.0 / std::max(1, dist_to_sphinx) : 0.0;

                double leaf_score = goal_term + tie_break + proximity_penalty + stay_penalty;
                expected_score += probability * leaf_score;
            } else {
                double max_score = evaluate_state(map, values, next_duck, next_sphinx, depth + 1, max_depth,
                                                  bfs_cache, bfs_cached, sphinx_bfs_cache, sphinx_bfs_cached,
                                                  memo, memo_valid);
                expected_score += probability * (max_score + stay_penalty);
            }
        }
        return expected_score;
    }

    static std::vector<std::pair<Direction, double>> slip_outcomes(Direction action) {
        if (action == Direction::Stay) return {{Direction::Stay, 1.0}};
        const auto [left, right] = agent::perpendicular(action);
        return {
            {action, 1.0 - kSlipProbability},
            {left, kSlipProbability / 4.0},
            {right, kSlipProbability / 4.0},
            {Direction::Stay, kSlipProbability / 2.0},
        };
    }
};

class DuckAgent {
public:
    explicit DuckAgent(int intelligence_level) : intelligence_(intelligence_level) {}

    void handle_init(const Json& message) {
        const auto dimensions = agent::map_size_to_dimensions(message.at("map_size"));
        goal_ = agent::parse_point(message.at("goal"));
        map_.initialize(dimensions.y, dimensions.x, goal_);
        values_.recompute(map_);
        std::cerr << "[duck] initialized " << dimensions.x << "x" << dimensions.y << " goal=(" << goal_.x << "," << goal_.y << ") level=" << intelligence_.level << std::endl;
    }

    Direction decide(const Observation& observation) {
        if (!map_.ready()) return Direction::Stay;
        if (observation.status != "ACTIVE") return Direction::Stay;

        map_.update_field_of_view(observation);

        if (intelligence_.is_random) {
            std::vector<Direction> valid_moves;
            for (const auto direction : agent::move_directions()) {
                if (map_.passable(agent::moved(observation.position, direction))) {
                    valid_moves.push_back(direction);
                }
            }
            if (valid_moves.empty()) return Direction::Stay;
            last_position_ = observation.position;
            return random_.choice(valid_moves);
        }
        radar_.update(map_, observation, intelligence_);
        if (intelligence_.use_forecast) forecast_.compute(map_, radar_, observation.position);

        if (intelligence_.use_risk_routing) {
            values_.recompute(map_, [&](Point point) {
                return kRiskRoutingCost * (intelligence_.use_forecast ? forecast_.at(point) : radar_.at(point));
            });
        } else {
            values_.recompute(map_);
        }

        Direction action = intelligence_.use_adversarial_planning
            ? planner_.choose_action(map_, values_, radar_.peak(), observation.position, last_position_, intelligence_.adversarial_depth)
            : greedy_goal_action(observation.position);
        last_position_ = observation.position;
        return action;
    }

    std::string response(Direction action) const {
        const std::string command = "ACTION: " + std::string(agent::to_string(action));
        if (!intelligence_.emit_telemetry) return agent::response_envelope(command);
        return agent::response_envelope(
            command,
            agent::TargetEstimate{radar_.peak(), radar_.values(), radar_.confidence()}
        );
    }

private:
    Direction greedy_goal_action(Point position) const {
        Direction best = Direction::Stay;
        double best_value = values_.value(position);
        for (const auto direction : agent::move_directions()) {
            const Point next = agent::moved(position, direction);
            if (!map_.grid().in_bounds(next) || !map_.passable(next)) continue;
            const double value = values_.value(next);
            if (value < best_value) {
                best_value = value;
                best = direction;
            }
        }
        return best;
    }

    DuckIntelligence intelligence_;
    Point goal_;
    LocalMap map_;
    ValueField values_;
    NaiveBayesRadar radar_;
    EnemyForecast forecast_;
    AdversarialPlanner planner_;
    agent::RandomSource random_;
    Point last_position_ = {-1, -1};
};

Observation parse_observation(const Json& message) {
    Observation observation;
    observation.turn = message.at("turn").as_int();
    observation.status = message.at("status").as_string("ACTIVE");
    observation.position = agent::parse_point(message.at("pos"));
    observation.sound = agent::sensor_value(message, "sound");
    observation.heat = agent::sensor_value(message, "heat");
    observation.radio = agent::sensor_value_double(message, "radio");

    const auto* sensors = message.find("sensors");
    if (sensors) {
        const auto* compass_val = sensors->find("compass");
        if (compass_val) observation.compass = compass_val->as_string("UNKNOWN");
    }

    if (message.has("sphinx_pos")) {
        observation.sphinx_pos = agent::parse_point(message.at("sphinx_pos"));
    }

    const auto& fov = message.at("fov");
    observation.fov_radius = fov.at("radius").as_int();
    observation.fov = agent::parse_int_grid(fov.at("grid"));
    return observation;
}
}  // namespace

int main(int argc, char* argv[]) {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    DuckAgent agent(agent::parse_intelligence_level(argc, argv));
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
            std::cerr << "[duck] fallback after error: " << error.what() << std::endl;
            std::cout << "ACTION: STAY" << std::endl;
        }
    }

    return 0;
}
