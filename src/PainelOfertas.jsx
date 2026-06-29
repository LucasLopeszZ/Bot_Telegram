import { useState, useEffect, useRef } from "react";
import { Unlock, ExternalLink, Check, Clock, RefreshCw, Tag, ShoppingBag } from "lucide-react";

const SENHA_EDICAO = "Passada_Certa";

// Mesma configuração usada no coletar.py e publicar.py -- os três
// precisam apontar para o mesmo bin para se "verem".
const JSONBIN_MASTER_KEY = "$2a$10$Pd3WXBjIEo578Wf6gVlGruq1dhyvEyh1.zpl4DfceChoKXeX3Wz2i";
const JSONBIN_BIN_ID = "6a41b961da38895dfe0d7c74";
const URL_NUVEM = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

export default function PainelOfertas() {
  const [autenticado, setAutenticado] = useState(false);
  const [senhaDigitada, setSenhaDigitada] = useState("");
  const [erroSenha, setErroSenha] = useState(false);

  const [ofertas, setOfertas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState("todas"); // todas | pendentes | publicadas
  const [salvandoId, setSalvandoId] = useState(null);
  const [toast, setToast] = useState(null);

  const linkInputsRef = useRef({});

  // ------------------------------------------------------------
  // Carregamento inicial + dados de exemplo (primeira vez)
  // ------------------------------------------------------------
  useEffect(() => {
    carregarOfertas();
  }, []);

  async function carregarOfertas() {
    setCarregando(true);
    try {
      const resposta = await fetch(URL_NUVEM, {
        headers: { "X-Master-Key": JSONBIN_MASTER_KEY },
      });
      if (!resposta.ok) throw new Error("Falha ao buscar dados");
      const dados = await resposta.json();
      setOfertas(dados.record?.ofertas || []);
    } catch (erro) {
      mostrarToast("Não consegui carregar a lista. Tente atualizar.", "erro");
      setOfertas([]);
    } finally {
      setCarregando(false);
    }
  }

  async function salvarOfertas(novaLista) {
    try {
      const resposta = await fetch(URL_NUVEM, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Master-Key": JSONBIN_MASTER_KEY,
        },
        body: JSON.stringify({ ofertas: novaLista }),
      });
      if (!resposta.ok) throw new Error("Falha ao salvar");
      return true;
    } catch (erro) {
      mostrarToast("Erro ao salvar. Tente novamente.", "erro");
      return false;
    }
  }

  function mostrarToast(texto, tipo = "sucesso") {
    setToast({ texto, tipo });
    setTimeout(() => setToast(null), 2500);
  }

  // ------------------------------------------------------------
  // Autenticação simples por senha compartilhada
  // ------------------------------------------------------------
  function tentarEntrar() {
    if (senhaDigitada === SENHA_EDICAO) {
      setAutenticado(true);
      setErroSenha(false);
    } else {
      setErroSenha(true);
    }
  }

  // ------------------------------------------------------------
  // Edição de link de afiliado
  // ------------------------------------------------------------
  async function salvarLinkAfiliado(id) {
    const valor = linkInputsRef.current[id]?.value?.trim() || "";
    setSalvandoId(id);

    const novaLista = ofertas.map((o) =>
      o.id === id ? { ...o, link_afiliado: valor } : o
    );

    const ok = await salvarOfertas(novaLista);
    if (ok) {
      setOfertas(novaLista);
      mostrarToast(valor ? "Link salvo!" : "Link removido.");
    }
    setSalvandoId(null);
  }

  async function marcarComoPublicado(id, valor) {
    const novaLista = ofertas.map((o) =>
      o.id === id ? { ...o, publicado: valor } : o
    );
    setOfertas(novaLista);
    await salvarOfertas(novaLista);
    mostrarToast(valor ? "Marcada como publicada." : "Desmarcada.");
  }

  // ------------------------------------------------------------
  // Dados de demonstração -- útil para testar o painel mesmo antes
  // do coletar.py ter rodado e populado a nuvem
  // ------------------------------------------------------------
  async function carregarExemplo() {
    const exemplo = [
      {
        id: "ex1",
        titulo: "Tênis Olympikus Corre 4 Masculino",
        preco: "R$ 449,99",
        loja: "netshoes.com.br",
        link_original: "https://www.promobit.com.br/oferta/olympikus-corre-4-123/",
        link_afiliado: "",
        publicado: false,
      },
      {
        id: "ex2",
        titulo: "Whey Protein Growth Concentrado 1kg",
        preco: "R$ 89,90",
        loja: "shopee.com.br",
        link_original: "https://www.promobit.com.br/oferta/whey-growth-456/",
        link_afiliado: "https://www.magazinevoce.com.br/magazinepassadacerta/busca/whey/",
        publicado: true,
      },
      {
        id: "ex3",
        titulo: "Creatina Growth 300g",
        preco: "R$ 64,90",
        loja: "amazon.com.br",
        link_original: "https://www.promobit.com.br/oferta/creatina-growth-789/",
        link_afiliado: "",
        publicado: false,
      },
    ];
    const ok = await salvarOfertas(exemplo);
    if (ok) {
      setOfertas(exemplo);
      mostrarToast("Exemplos carregados na nuvem.");
    }
  }

  // ------------------------------------------------------------
  // Filtros
  // ------------------------------------------------------------
  const ofertasFiltradas = ofertas.filter((o) => {
    if (filtro === "pendentes") return !o.publicado;
    if (filtro === "publicadas") return o.publicado;
    return true;
  });

  const totalPendentes = ofertas.filter((o) => !o.publicado).length;
  const totalSemLink = ofertas.filter((o) => !o.link_afiliado?.trim()).length;
  const totalPublicadas = ofertas.filter((o) => o.publicado).length;

  // ------------------------------------------------------------
  // Tela de login
  // ------------------------------------------------------------
  if (!autenticado) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center p-6"
           style={{ background: "linear-gradient(135deg, #0f2e1f 0%, #0a1f15 100%)" }}>
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
                 style={{ background: "#1D6E4E" }}>
              <ShoppingBag className="text-white" size={28} />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Passada Certa</h1>
            <p className="text-sm text-emerald-200/70 mt-1">Painel de ofertas</p>
          </div>

          <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6">
            <label className="block text-sm font-medium text-emerald-100 mb-2">
              Senha de acesso
            </label>
            <input
              type="password"
              value={senhaDigitada}
              onChange={(e) => { setSenhaDigitada(e.target.value); setErroSenha(false); }}
              onKeyDown={(e) => e.key === "Enter" && tentarEntrar()}
              placeholder="Digite a senha do canal"
              className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-emerald-400 transition-colors"
              autoFocus
            />
            {erroSenha && (
              <p className="text-rose-300 text-sm mt-2">Senha incorreta. Tente de novo.</p>
            )}
            <button
              onClick={tentarEntrar}
              className="w-full mt-4 py-3 rounded-xl font-medium text-white transition-opacity hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "#1D6E4E" }}
            >
              <Unlock size={16} /> Entrar
            </button>
          </div>
          <p className="text-center text-xs text-emerald-200/40 mt-6">
            Acesso restrito à equipe do canal
          </p>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------
  // Painel principal
  // ------------------------------------------------------------
  return (
    <div className="min-h-screen w-full" style={{ background: "#f7f9f8" }}>
      {/* Header */}
      <div className="sticky top-0 z-10 backdrop-blur border-b" style={{ background: "rgba(247,249,248,0.92)", borderColor: "#e2e8e4" }}>
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "#1D6E4E" }}>
              <ShoppingBag className="text-white" size={18} />
            </div>
            <div>
              <h1 className="font-bold text-gray-900 leading-tight">Passada Certa</h1>
              <p className="text-xs text-gray-500">Fila de ofertas para revisão</p>
            </div>
          </div>
          <button
            onClick={carregarOfertas}
            className="text-gray-400 hover:text-gray-700 transition-colors p-2 rounded-full hover:bg-gray-100"
            title="Atualizar lista"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6">

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-2xl font-bold text-gray-900">{totalPendentes}</p>
            <p className="text-xs text-gray-500 mt-0.5">Pendentes</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-2xl font-bold" style={{ color: "#D97706" }}>{totalSemLink}</p>
            <p className="text-xs text-gray-500 mt-0.5">Sem link</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-2xl font-bold" style={{ color: "#1D9E75" }}>{totalPublicadas}</p>
            <p className="text-xs text-gray-500 mt-0.5">Publicadas</p>
          </div>
        </div>

        {/* Filtros */}
        <div className="flex gap-2 mb-5">
          {[
            { id: "todas", label: "Todas" },
            { id: "pendentes", label: "Pendentes" },
            { id: "publicadas", label: "Publicadas" },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFiltro(f.id)}
              className="px-4 py-1.5 rounded-full text-sm font-medium transition-colors"
              style={
                filtro === f.id
                  ? { background: "#1D6E4E", color: "#fff" }
                  : { background: "#fff", color: "#4b5563", border: "1px solid #e5e7eb" }
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Estado vazio */}
        {carregando && (
          <div className="text-center py-16 text-gray-400">Carregando ofertas...</div>
        )}

        {!carregando && ofertas.length === 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
            <Tag className="mx-auto text-gray-300 mb-3" size={36} />
            <p className="text-gray-500 mb-1">Nenhuma oferta na fila ainda</p>
            <p className="text-sm text-gray-400 mb-5">
              Rode o <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">coletar.py</code> no seu computador para popular a fila.
            </p>
            <button
              onClick={carregarExemplo}
              className="text-sm px-4 py-2 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Carregar exemplos para visualizar
            </button>
          </div>
        )}

        {!carregando && ofertas.length > 0 && ofertasFiltradas.length === 0 && (
          <div className="text-center py-16 text-gray-400">Nenhuma oferta neste filtro.</div>
        )}

        {/* Lista de ofertas */}
        <div className="space-y-3">
          {ofertasFiltradas.map((oferta) => {
            const temLink = !!oferta.link_afiliado?.trim();
            return (
              <div
                key={oferta.id}
                className="bg-white rounded-2xl border p-4"
                style={{ borderColor: oferta.publicado ? "#bbe5d3" : "#e5e7eb" }}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900 leading-snug">{oferta.titulo}</h3>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-sm font-bold" style={{ color: "#1D6E4E" }}>{oferta.preco}</span>
                      <span className="text-xs text-gray-400">•</span>
                      <span className="text-xs text-gray-500">{oferta.loja}</span>
                    </div>
                  </div>
                  {oferta.publicado ? (
                    <span className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0"
                          style={{ background: "#e6f6ee", color: "#1D9E75" }}>
                      <Check size={12} /> Publicada
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0"
                          style={{ background: "#fef3e2", color: "#D97706" }}>
                      <Clock size={12} /> Pendente
                    </span>
                  )}
                </div>

                <a
                  href={oferta.link_original}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 mb-3 truncate"
                >
                  <ExternalLink size={11} className="flex-shrink-0" />
                  <span className="truncate">{oferta.link_original}</span>
                </a>

                <div className="flex gap-2">
                  <input
                    ref={(el) => (linkInputsRef.current[oferta.id] = el)}
                    type="text"
                    defaultValue={oferta.link_afiliado}
                    placeholder="Cole aqui seu link de afiliado..."
                    className="flex-1 px-3 py-2 text-sm rounded-xl border focus:outline-none focus:border-emerald-400 transition-colors"
                    style={{ borderColor: "#e5e7eb" }}
                  />
                  <button
                    onClick={() => salvarLinkAfiliado(oferta.id)}
                    disabled={salvandoId === oferta.id}
                    className="px-3 py-2 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 flex-shrink-0"
                    style={{ background: "#1D6E4E" }}
                  >
                    {salvandoId === oferta.id ? "..." : "Salvar"}
                  </button>
                </div>

                <div className="flex items-center justify-between mt-3 pt-3 border-t" style={{ borderColor: "#f3f4f6" }}>
                  <span className="text-xs text-gray-400">
                    {temLink ? "✓ Link de afiliado definido" : "Sem link de afiliado ainda"}
                  </span>
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!oferta.publicado}
                      onChange={(e) => marcarComoPublicado(oferta.id, e.target.checked)}
                      className="w-4 h-4 rounded accent-emerald-600"
                    />
                    Marcar como publicada
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-full text-sm font-medium text-white shadow-lg transition-opacity"
          style={{ background: toast.tipo === "erro" ? "#dc2626" : "#1D6E4E" }}
        >
          {toast.texto}
        </div>
      )}
    </div>
  );
}
