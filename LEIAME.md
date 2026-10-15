# Painel - Nível de Serviço (v3.7.1)

Painel de NS 5 min por **Dia**, **Semana** e **Mês**, alimentado pelo TXT exportado do Oracle SQL Developer.

## Atualizar os dados para todos
1. Exporte o resultado da consulta como TXT (colunas separadas por **tabulação**, com o cabeçalho na 1ª linha).
2. No repositório do GitHub, substitua o arquivo `data.txt` (mesmo nome, mesma pasta do `index.html`).
3. Quem abrir o app recebe os dados novos. Se o arquivo tiver erro, o app ignora e continua mostrando os últimos dados válidos.

Também dá para importar o TXT direto no app (aba **Dados**). Nesse caso, os dados ficam só naquele aparelho.

## Formato
- **Colunas obrigatórias:** `PERIODO, QUANTIDADE_DIAS, VOLUME, TOTAL_ATENDIDAS, ATE_5_MIN, TIPO_PERIODO, ORDEM`.
- **Colunas opcionais:** `NS_5_MIN, META_NS, STATUS_NS, STATUS_PERIODO`.
- **Colunas novas:** podem entrar em qualquer posição. O app guarda o valor delas e mostra no detalhe de cada período.
- **`ORDEM`:** é o tipo seguido da data de início. O tipo é `1` para mês, `2` para semana e `3` para dia, e a data vem como `AAAAMMDD`. Exemplos: `120261001`, `220261005`, `320261007`.
- **Números:** sem separador de milhar. O decimal pode ser com vírgula ou ponto.

## Segmentos (B2C, COE…)
O TXT pode trazer mais de um segmento, um embaixo do outro, com estas colunas a mais ou com nome genérico:
- `SEGMENTO`: nome do segmento (ex.: `B2C`, `COE`). No app, o menu no topo alterna entre eles (B2C primeiro).
- `TEMPO_CORTE_MINUTOS`: o tempo de corte do segmento (B2C 5, COE 1). Os textos do app seguem esse valor ("NS 5 min", "NS 1 min").
- `ATENDIDAS_NO_CORTE` (= antigo `ATE_5_MIN`) e `NIVEL_SERVICO` (= antigo `NS_5_MIN`).
- **Base do NS de cada segmento**: o app descobre pela própria coluna do NS. B2C = no corte ÷ atendidas; COE = no corte ÷ chamadas recebidas (`VOLUME`). Linha que não bate com a conta do segmento é recusada.
- Período com `VOLUME` 0 (sem dados) não aparece em lugar nenhum (cards, gráficos, tabela, mensagem).
- O arquivo antigo (sem `SEGMENTO`) continua valendo: é lido como B2C, 5 min.
- O compartilhar manda só o segmento que está na tela.

## O que é conferido antes de salvar
- NS = ATE_5_MIN ÷ TOTAL_ATENDIDAS.
- VOLUME ≥ TOTAL ≥ ATE.
- `ORDEM` combina com `TIPO_PERIODO`.
- QUANTIDADE_DIAS combina com `STATUS_PERIODO`.
- Mês e semana batem com a soma dos dias, quando todos os dias do período estão no arquivo.
- Não há linha repetida (dentro de cada segmento). Somas e períodos abertos também são conferidos por segmento.
- Período fechado que mudou em relação ao que já estava salvo pede confirmação.

## Comparar o mesmo dia da semana
No modo **Dia**, acima dos gráficos ficam as cápsulas **DOM SEG TER QUA QUI SEX SÁB**.
- Sem filtro: os 7 dias mais recentes, corridos.
- Tocar num dia da semana: mostra só aquele dia (até 7 ocorrências: segunda com segunda etc.). Cards, gráficos e tabela passam a comparar com o mesmo dia da semana anterior.
- Tocar de novo no dia ligado, ou no **✕**, volta aos dias corridos. O ✕ só aparece com o filtro ligado.
- Para ter 7 de cada dia da semana, o TXT precisa trazer pelo menos 49 dias (com 42 dias aparecem 6).

## Meta
A meta vem da coluna **`META_NS`** de cada linha: cada segmento (e cada período) pode ter a sua, e uma mudança no select aparece no app sem mexer no código. Sem a coluna no arquivo, vale 90%.
Situação: Meta atingida ≥ meta · Em atenção ≥ 70% · Crítico < 70%.

## Problemas sistêmicos (`sistemas.txt`)
Card logo abaixo do gráfico de NS, acima da tabela. Ele aparece quando existe o arquivo **`sistemas.txt`** na mesma pasta do `data.txt`. Sem o arquivo, o card some.
- **Atualizar:** substitua o `sistemas.txt` no repositório, como no `data.txt`. É o TXT do SQL Developer, separado por tabulação e com o cabeçalho na 1ª linha. Colunas obrigatórias: `SISTEMA, DATA_INICIO, DATA_FIM`. As demais (`ID, CHAMADO, STATUS, TIPO_FALHA`…) aparecem no detalhe, e coluna nova vai para "Outras colunas".
- **Todos os chamados**: o card não filtra por segmento. É o mesmo no B2C e no COE.
- **Mesmo calendário dos gráficos de cima**: as colunas são os mesmos dias, semanas ou meses (inclusive com o filtro de dia da semana).
  - Período fora do arquivo de sistemas fica **listrado ("sem dados de sistemas")**. É o período antes do 1º chamado ou depois da última atualização.
  - É diferente de célula lisa, que significa "sem problema".
- **Expediente 08h–20h**: cada barra é o trecho do chamado dentro do expediente.
  - O Total junta todos os sistemas; sobreposição conta uma vez.
  - Indevido aparece hachurado e fica fora das contas.
  - Chamado só fora do expediente aparece como um tracejado.
- **Percentual** = tempo no expediente ÷ expediente do período inteiro (dia 12h; semana 7 × 12h; mês dias × 12h).
- **Toques**:
  - O cabeçalho da coluna seleciona o período no painel inteiro, como nos gráficos.
  - Selecionar nos gráficos ou na tabela destaca a mesma coluna.
  - Célula com chamado abre a lista; item da lista abre o detalhe.
- **Sempre abre fechado**, só com a linha Total. A seta abre com todos os sistemas.
- **Conferência**: linha com data inválida é ignorada e aparece num aviso no card.
  - Se o arquivo inteiro for inválido, o app mantém o último válido e avisa.
  - A cópia fica no aparelho para abrir sem internet.
