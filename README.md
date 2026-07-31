<p align="center" style="text-align:center">
  <img src="./resources/ai-tour-meeting-logo.png" align="center" width="100%">
</p>

<p align="center">
  <a href="https://ntt-dkiku.github.io/ai-tour-meeting/" target="_blank"><img src="https://img.shields.io/badge/📗-docs-green"></a>
  <a href="https://arxiv.org/abs/2607.18806" target="_blank"><img src="https://img.shields.io/badge/arXiv-pdf-red"></a>
  <a href="https://ntt-rd.app.box.com/s/kvca8nvs1i3gdfh0xcvrrza7qx8w19om" target="_blank"><img src="https://img.shields.io/badge/demo-video-blue"></a>
</p>

This repo is the official implementation of "AI Tour Meeting: Group Travel Planning by LLM Agents" (arXiv preprint). AI Tour Meeting is a group travel planning framework powered by multiple LLM-based agents, where the agents collaborate with each other to find an itinerary that satisfies their constraints and preferences. Its two primary use cases include, but not limited to:
  1) a simulation tool for analyzing the behavior of multiple LLM-based agents during tour planning discussions
  2) a recommender system where persona-based agents act on behalf of group members who are unable to participate and provide ideas from their perspectives


https://github.com/user-attachments/assets/a28b8944-08b7-4eef-9223-8028a9cf6fc8


## 🚀 Getting Started

### 0. Requirements
- Docker ([Official Docker installation guide](https://docs.docker.com/engine/install/ubuntu/))
- Make (```apt install make```)

### 1. Clone this repository
Clone this repository and navigate into the project directory.
```bash
git clone https://github.com/ntt-dkiku/ai-tour-meeting.git
cd ai-tour-meeting
```

### 2. Set your API keys in the `.env` file (optional)
Create your .env file and add your API keys.
```
cp docker/.env.example docker/.env
```
> [!TIP]  
> You can also set API keys from the GUI (`Settings` in the sidebar), so this step can be skipped. 
> However, in that case, you will need to enter the keys every time you open the GUI.
> If you prefer not to store your API keys in plain text in the .env file, this may be a better option.

### 3. Deploy AI Tour Meeting
Deploy AI Tour Meeting with the following command:
```bash
make up
```
After the deployment, access `localhost:3000` in your browser, and you can try the AI Tour Meeting GUI in your browser! (You can also use `make up OPEN_GUI=1` to open the browser automatically.)

> [!TIP]
> If you are working on a remote server, don't forget to set up port forwarding, e.g., `ssh <remote-server-name> -L 3000:localhost:3000 -L 8080:localhost:8080`.
> The backend port defaults to `8080` and can be changed via the `BACKEND_PORT` environment variable (e.g. `BACKEND_PORT=9090 make up`).

#### Local LLMs
##### Ollama
If you want to use local LLMs via Ollama, add the `OLLAMA` option: `OLLAMA=cpu` for CPU mode, or `OLLAMA=gpu` for GPU mode (NVIDIA GPUs Only).
```bash
# CPU mode
make up OLLAMA=cpu
# Use all GPUs in a single ollama server
make up OLLAMA=gpu
# Specify GPUs used in a single ollama server
make up OLLAMA=gpu:0,1
# Specify GPUs used in separeted ollama servers
make up OLLAMA="gpu:0,1 gpu:2,3"
```

##### vLLM (GPU Only)
You can also use [vLLM](https://docs.vllm.ai/) to serve local models. Add the `VLLM` option with the model name. An NVIDIA GPU is required.
```bash
# Single model on single GPU
make up VLLM=Qwen/Qwen3-8B
# Single model on multiple GPUs
make up VLLM="Qwen/Qwen3-32B:gpu=0,1"
# Multiple models on separated GPUs
make up VLLM="Qwen/Qwen3-8B:gpu=0 openai/gpt-oss-20b:gpu=1"
# Multiple models on multiple GPUs
make up VLLM="Qwen/Qwen3-32B:gpu=0,1 openai/gpt-oss-120b:gpu=2,3"
```

> [!NOTE]
> For gated models (e.g., Llama), set `HF_TOKEN` in `docker/.env`.

#### Other Commands
```bash
make down  # Stop and remove containers
make logs  # Show container logs
make open  # Open GUI in browser
make clean # Remove containers, volumes, and images
make help  # Show all available commands
```

## 🕹️ GUI Control
Please check our demonstration video (https://ntt-rd.box.com/s/d4xpvk62cqlxk9828sydalibkocw5pgt).

## 🐍 Python API
You can run tour meetings via Python scripts.  
Scripts are executed inside the backend Docker container, so **`make up` must be running first**.

```bash
# Start containers
make up

# Run a script
make run SCRIPT=path/to/your_tour.py
# Run a script with arguments
make run SCRIPT=path/to/your_tour.py ARGS="<arguments defined in your_tour.py, e.g., --model openai/gpt-5.2>"
```

### Minimal example
See [examples/](examples/) for more example scripts.

```python
import asyncio
from tour_meeting.cli import build_meeting

meeting = build_meeting(
    title="One-Day Tokyo Tour",
    global_goals="Plan a fun one-day walking tour in Tokyo.",
    participants=[
        {
            "name": "Alice",
            "background": "A history enthusiast visiting Tokyo for the first time.",
            "personality": "Curious and detail-oriented.",
            "preferences": "Prefers temples and quiet historical sites over crowds.",
            "personal_goals": "Visit Senso-ji and the Imperial Palace.",
            "model_name": "vllm/0/Qwen/Qwen3-8B",
            "role": "facilitator",
        },
        {
            "name": "Bob",
            "background": "A food blogger who writes about street food.",
            "personality": "Enthusiastic and spontaneous.",
            "preferences": "Wants to try local street food over sit-down restaurants.",
            "personal_goals": "Explore Tsukiji Outer Market and ramen shops.",
            "model_name": "vllm/0/Qwen/Qwen3-8B",
            "system_prompt": "You are {name}, an enthusiastic foodie. {background}\nFocus on: {personal_goals} ...",
        },
    ],
    constraints={"budget": "$100", "time_window_start": "09:00", "time_window_end": "18:00"},
    settings={"max_turns": 100, "turn_rule": "round_robin", "voting_rule": "majority"},
)

asyncio.run(meeting.run_cli())
```

## 🐞 Bug report and questions
If you encounter bugs or have any questions, please post issues or discussions in this repo. New feature requests are also welcome.

## 📄 License
Our code is licensed by NTT. The use of our code is limited to research purposes. See [LICENSE](./LICENSE.md) for details.

## 🤝 Citation
If you find this work useful, please cite our paper as follows:
```
@misc{kikuta2026aitourmeeting,
      title={AI Tour Meeting: Group Travel Planning by LLM Agents}, 
      author={Daisuke Kikuta},
      year={2026},
      eprint={2607.18806},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2607.18806}, 
}
```
